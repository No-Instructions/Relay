import { TFile, type TextFileView } from "obsidian";

/**
 * Obsidian gives every view of a file its own dirty flag, save timer, and
 * last-saved copy. A view's `save` clears `dirty`; if a write is already in
 * flight it only asks for another pass, and if the buffer equals the
 * last-saved copy it returns. Otherwise it records the buffer as `data` and
 * `lastSavedData`, raises `saving`, and writes the file; a rejected write
 * restores the view's previous `lastSavedData`. When the file changes under
 * a view, the view's reload compares the file against its own last-saved
 * copy and treats any difference as an external modification to merge with
 * its buffer.
 *
 * For a Relay document in active tracking every text view is fed from the
 * same local CRDT, so one view's write puts text on disk that every sibling
 * already holds. Recording that text as each sibling's last-saved copy makes
 * the sibling's reload find the file equal to its own last save and leave
 * the view alone, and lets a sibling whose buffer equals that text skip its
 * own write. Without the recording a sibling replays its buffer's edits onto
 * text that already contains them: the typed text is duplicated and the
 * "modified externally" notice appears.
 */

/** The fields of a text view that Obsidian's save and reload paths use. */
export interface SavingTextView {
	file: TFile | null;
	dirty?: boolean;
	saving?: boolean;
	data?: string | null;
	lastSavedData?: string | null;
	getViewData(): string;
	requestSave(): void;
}

export interface SiblingSaveDeps {
	/** Visits every open text view Relay drives. */
	forEachTextView(fn: (view: TextFileView) => void): void;
	/**
	 * Whether every view of `file` shows the same text: the file is a Relay
	 * document in active tracking, whose views are all fed from its local
	 * CRDT.
	 */
	viewsShareText(file: TFile): boolean;
	debug(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

type SaveMethod = (this: SavingTextView, clear?: boolean) => unknown;

interface Recorded {
	sibling: SavingTextView;
	dirty: boolean | undefined;
	data: string | null | undefined;
	lastSavedData: string | null | undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PromiseLike<unknown>).then === "function"
	);
}

/**
 * Records a view's save on its sibling views and undoes the recording when
 * the write is rejected. `wrap` is the `save` replacement to install on
 * `TextFileView.prototype`.
 */
export class SiblingSaveRecorder {
	/**
	 * The recording each sibling most recently received. A rejected write
	 * undoes only its own recording; a later save that recorded the same
	 * sibling again owns the sibling's copy.
	 */
	private recordings = new WeakMap<object, symbol>();
	private premiseReported = false;

	constructor(private deps: SiblingSaveDeps) {}

	/** Wraps the original `save` method. */
	wrap = (original: SaveMethod): SaveMethod => {
		const record = this.record.bind(this);
		const reportPremiseFailure = this.reportPremiseFailure.bind(this);
		const debug = this.deps.debug;
		return function (this: SavingTextView, clear?: boolean) {
			const wasSaving = this.saving === true;
			const file = this.file;
			const lastSavedBefore = this.lastSavedData;
			// A closing save clears the view after reading its buffer, so the
			// text it writes can only be read before the call.
			let closingText: string | undefined;
			if (clear && !wasSaving) {
				try {
					closingText = this.getViewData();
				} catch {
					closingText = undefined;
				}
			}
			const result = original.call(this, clear);
			if (wasSaving || !(file instanceof TFile)) {
				return result;
			}
			let undo: (() => void) | undefined;
			try {
				// The original records the text it is writing and raises
				// `saving` before its first await, so a write started by this
				// call is visible here. A call that found a write already in
				// flight only asked for another pass and records nothing.
				if (this.saving === true) {
					const text = clear ? closingText : this.lastSavedData;
					if (typeof text === "string") {
						undo = record(this, file, text);
					}
				} else if (!clear && this.lastSavedData !== lastSavedBefore) {
					reportPremiseFailure();
				}
			} catch (e) {
				debug("Error recording a save on sibling views:", e);
			}
			if (!undo || !isThenable(result)) {
				return result;
			}
			// A rejected write leaves the file as it was. The original
			// restores its own last-saved copy; the siblings' copies are
			// restored here, and the rejection reaches the caller unchanged.
			const restoreSiblings = undo;
			return result.then(
				(value) => value,
				(error: unknown) => {
					restoreSiblings();
					throw error;
				},
			);
		};
	};

	/**
	 * Records `text`, which `view` is writing to `file`, as the last-saved
	 * copy of every other view of `file`. Returns the undo for a rejected
	 * write, or nothing when no sibling was recorded.
	 */
	private record(
		view: SavingTextView,
		file: TFile,
		text: string,
	): (() => void) | undefined {
		if (!this.deps.viewsShareText(file)) {
			return undefined;
		}
		const recorded: Recorded[] = [];
		this.deps.forEachTextView((candidate) => {
			const sibling = candidate as unknown as SavingTextView;
			if (sibling !== view && sibling.file === file) {
				recorded.push({
					sibling,
					dirty: sibling.dirty,
					data: sibling.data,
					lastSavedData: sibling.lastSavedData,
				});
			}
		});
		if (recorded.length === 0) {
			return undefined;
		}
		const recording = Symbol("sibling save");
		for (const { sibling } of recorded) {
			this.recordings.set(sibling, recording);
			sibling.data = text;
			sibling.lastSavedData = text;
		}
		return () => {
			for (const { sibling, dirty, data, lastSavedData } of recorded) {
				if (this.recordings.get(sibling) !== recording) {
					// A later save recorded this sibling again.
					continue;
				}
				this.recordings.delete(sibling);
				if (sibling.lastSavedData !== text) {
					// The sibling's own save or reload has moved its copy on.
					continue;
				}
				sibling.data = data;
				sibling.lastSavedData = lastSavedData;
				if (dirty === true && sibling.dirty === false) {
					// The sibling's timer fired while the optimistic copy was
					// installed, found nothing to write, and consumed its dirty
					// flag. Re-arm it now that the native write has rejected.
					try {
						sibling.requestSave();
					} catch (e) {
						this.deps.debug(
							"Error re-arming a sibling save after a rejected write:",
							e,
						);
					}
				}
			}
		};
	}

	/**
	 * A save that changed the view's last-saved copy without raising
	 * `saving` means the installed `save` no longer records its text before
	 * its first await. Sibling views then keep their own copies and reload
	 * as they would without the recorder; say so once.
	 */
	private reportPremiseFailure(): void {
		if (this.premiseReported) return;
		this.premiseReported = true;
		this.deps.warn(
			"TextFileView.save changed the last-saved copy without raising saving; sibling views are not recorded",
		);
	}
}
