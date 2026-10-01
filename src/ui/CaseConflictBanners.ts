import { Component, setIcon, type App, type TextFileView, type TFile } from "obsidian";
import type { SharedFolder, SharedFolders } from "../SharedFolder";
import { iterateCanvasViews, type CanvasView } from "../CanvasView";
import { iterateTextFileViews, type TextViewRegistry } from "../TextViewRegistry";
import { caseConflictState, type ExplainCaseConflict } from "../caseConflictState";
import { Banner } from "./Banner";

type FileView = TextFileView | CanvasView;
type Entry = { key: string; banner: Banner };
type Wanted = { key: string; label: string; file: TFile; folder: SharedFolder };

/**
 * Warns on open files whose path, or a folder above it, conflicts in case with
 * another shared path. The warning is advisory: the file keeps syncing, so the
 * banner has its own slot beside whatever the live view shows. It is one line
 * with a way to the explanation and a dismissal; a dismissed conflict stays
 * quiet in that view until the conflict changes.
 */
export class CaseConflictBanners extends Component {
	private banners = new Map<FileView, Entry>();
	private dismissed = new WeakMap<FileView, Set<string>>();
	private watched = new WeakSet<SharedFolder>();
	private unloaded = false;

	constructor(
		private app: App,
		private folders: SharedFolders,
		private registry: TextViewRegistry,
		private explain?: ExplainCaseConflict,
	) { super(); }

	onload(): void {
		this.register(this.folders.subscribe(() => {
			this.folders.forEach(folder => this.watch(folder));
			this.refresh();
		}));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
	}

	onunload(): void {
		this.unloaded = true;
		this.banners.forEach(({ banner }) => banner.destroy());
		this.banners.clear();
	}

	/**
	 * Conflicts come and go with membership, and their wording with what this
	 * machine holds back; neither changes with any view event.
	 */
	private watch(folder: SharedFolder): void {
		if (this.watched.has(folder)) return;
		this.watched.add(folder);
		for (const unsubscribe of [
			folder.syncStore.subscribe(() => this.refresh()),
			folder.heldCasePaths.subscribe(() => this.refresh()),
		]) {
			this.register(unsubscribe);
			folder.onDestroy(unsubscribe);
		}
		folder.whenReady().then(() => this.refresh(), () => {});
	}

	private refresh(): void {
		if (this.unloaded) return;
		const wanted = new Map<FileView, Wanted>();
		const consider = (view: FileView, file: TFile | null | undefined) => {
			if (!file) return;
			const folder = this.folders.lookup(file.path);
			const state = folder ? caseConflictState(folder, file) : null;
			if (!folder || !state) return;
			// The conflict as a whole: the banner stays while its spellings, effect and wording hold.
			const key = [file.path, state.path, state.otherPath, state.effect, state.label].join("\n");
			if (this.dismissed.get(view)?.has(key)) return;
			wanted.set(view, { key, label: state.label, file, folder });
		};
		iterateTextFileViews(this.app.workspace, this.registry, view => consider(view, view.file));
		iterateCanvasViews(this.app.workspace, view => consider(view, view.file));
		for (const [view, entry] of this.banners) {
			if (wanted.get(view)?.key !== entry.key) {
				entry.banner.destroy();
				this.banners.delete(view);
			}
		}
		for (const [view, { key, label, file, folder }] of wanted) {
			if (this.banners.has(view)) continue;
			const explain = this.explain && (() => this.explain?.(folder, file));
			const banner = new Banner(
				view,
				{ short: "Name conflict", long: label },
				// On mobile the banner is a header button, and its tap opens the explanation.
				explain && (() => { explain(); return Promise.resolve(false); }),
				{ namespace: "relay-case-conflict", render: container => this.render(container, view, key, label, explain) },
			);
			this.banners.set(view, { key, banner });
		}
	}

	/** One line, "(more info)" to the explanation, and a dismissal. */
	private render(container: HTMLElement, view: FileView, key: string, label: string, explain?: () => void): () => void {
		const line = container.createDiv({ cls: "relay-case-conflict-line" });
		const text = line.createSpan({ cls: "relay-case-conflict-text" });
		text.appendText(label);
		if (explain) {
			text.appendText(" (");
			const more = text.createEl("button", { cls: "relay-case-conflict-link", text: "more info", attr: { type: "button" } });
			more.addEventListener("click", explain);
			text.appendText(")");
		}
		const close = line.createEl("button", { cls: "clickable-icon relay-case-conflict-close", attr: { type: "button", "aria-label": "Dismiss" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.dismiss(view, key));
		return () => {};
	}

	private dismiss(view: FileView, key: string): void {
		let keys = this.dismissed.get(view);
		if (!keys) {
			keys = new Set();
			this.dismissed.set(view, keys);
		}
		keys.add(key);
		const entry = this.banners.get(view);
		if (entry?.key === key) {
			entry.banner.destroy();
			this.banners.delete(view);
		}
	}
}
