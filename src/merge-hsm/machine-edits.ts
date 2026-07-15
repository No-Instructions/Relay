import * as Y from "yjs";
import { diff_match_patch } from "diff-match-patch";
import type { PositionedChange } from "./types";
import type { MachineEditAuthority } from "../folder-hsm/types";

export interface CapturedMachineEditSplice {
	/** Position in the callback's pinned CRDT base. */
	baseFrom: number;
	baseTo: number;
	deleted: string;
	insert: string;
	start: Uint8Array;
	end: Uint8Array;
}

export interface CapturedMachineEditDiff {
	baseUpdate: Uint8Array;
	baseStateVector: Uint8Array;
	splices: CapturedMachineEditSplice[];
}

export interface ResolvedMachineEditSplice {
	from: number;
	to: number;
	deleted: string;
	insert: string;
}

export interface LegacyPendingMachineEdit {
	kind: "legacy";
	fn: (data: string) => string;
	expectedText: string;
	captureMark: number;
	registeredAt: number;
}

export interface CapturedPendingMachineEdit {
	kind: "captured";
	id: number;
	authority: MachineEditAuthority;
	captureMark: number;
	registeredAt: number;
	/** Pinned only until Obsidian invokes the callback. */
	baseDoc: Y.Doc | null;
	capture: CapturedMachineEditDiff | null;
	remoteMatched: boolean;
}

export type PendingMachineEdit =
	| LegacyPendingMachineEdit
	| CapturedPendingMachineEdit;

export interface MachineEditCaptureHandle {
	id: number;
}

export interface MachineEditCaptureHost {
	captureMachineEditInvocation(
		handle: MachineEditCaptureHandle,
		input: string,
		output: string,
	): boolean;
	abortCapturedMachineEdit(handle: MachineEditCaptureHandle): void;
}

/**
 * Give the callback to Obsidian without preflight or replay. The supplied
 * invokeOriginal function is the only code allowed to invoke the wrapper.
 */
export async function runCapturedVaultProcess<T>(
	host: MachineEditCaptureHost,
	handle: MachineEditCaptureHandle,
	fn: (input: string) => string,
	invokeOriginal: (wrapped: (input: string) => string) => T | Promise<T>,
): Promise<T> {
	let invoked = false;
	const wrapped = (input: string): string => {
		try {
			const output = fn(input);
			if (!invoked) {
				invoked = true;
				host.captureMachineEditInvocation(handle, input, output);
			}
			return output;
		} catch (error) {
			host.abortCapturedMachineEdit(handle);
			throw error;
		}
	};

	try {
		const result = await invokeOriginal(wrapped);
		if (!invoked) host.abortCapturedMachineEdit(handle);
		return result;
	} catch (error) {
		host.abortCapturedMachineEdit(handle);
		throw error;
	}
}

/** Capture the callback's one legitimate input/output pair as anchored splices. */
export function captureMachineEditSplices(
	baseDoc: Y.Doc,
	input: string,
	output: string,
): CapturedMachineEditDiff | null {
	if (input === output) return null;

	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(input, output);
	dmp.diff_cleanupSemantic(diffs);
	const ytext = baseDoc.getText("contents");
	const baseText = ytext.toString();
	const splices: CapturedMachineEditSplice[] = [];
	let inputCursor = 0;
	let blockStart: number | null = null;
	let deleted = "";
	let inserted = "";

	const flush = (): boolean => {
		if (blockStart === null) return true;
		const baseFrom = blockStart;
		const baseTo = blockStart + deleted.length;
		// Exact deleted bytes are part of the captured operation. No whole-doc
		// equality or search is used to force a disk snapshot onto a CRDT base.
		if (baseText.slice(baseFrom, baseTo) !== deleted) return false;
		splices.push({
			baseFrom,
			baseTo,
			deleted,
			insert: inserted,
			start: Y.encodeRelativePosition(
				Y.createRelativePositionFromTypeIndex(ytext, baseFrom, -1),
			),
			end: Y.encodeRelativePosition(
				Y.createRelativePositionFromTypeIndex(ytext, baseTo, 0),
			),
		});
		blockStart = null;
		deleted = "";
		inserted = "";
		return true;
	};

	for (const [operation, text] of diffs) {
		if (operation === 0) {
			if (!flush()) return null;
			inputCursor += text.length;
			continue;
		}
		if (blockStart === null) blockStart = inputCursor;
		if (operation === -1) {
			deleted += text;
			inputCursor += text.length;
		} else if (operation === 1) {
			inserted += text;
		}
	}
	if (!flush() || splices.length === 0) return null;

	return {
		baseUpdate: Y.encodeStateAsUpdate(baseDoc),
		baseStateVector: Y.encodeStateVector(baseDoc),
		splices,
	};
}

export function resolveMachineEditSplices(
	doc: Y.Doc,
	capture: CapturedMachineEditDiff,
): ResolvedMachineEditSplice[] | null {
	return resolveMachineEditSplicesWithContent(doc, capture, "deleted");
}

/** Resolve a candidate already applied locally, before unpublished cancel. */
export function resolveAppliedMachineEditSplices(
	doc: Y.Doc,
	capture: CapturedMachineEditDiff,
): ResolvedMachineEditSplice[] | null {
	return resolveMachineEditSplicesWithContent(doc, capture, "insert");
}

function resolveMachineEditSplicesWithContent(
	doc: Y.Doc,
	capture: CapturedMachineEditDiff,
	expectedContent: "deleted" | "insert",
): ResolvedMachineEditSplice[] | null {
	const ytext = doc.getText("contents");
	const text = ytext.toString();
	const resolved: ResolvedMachineEditSplice[] = [];
	for (const splice of capture.splices) {
		const start = Y.createAbsolutePositionFromRelativePosition(
			Y.decodeRelativePosition(splice.start),
			doc,
		);
		const end = Y.createAbsolutePositionFromRelativePosition(
			Y.decodeRelativePosition(splice.end),
			doc,
		);
		if (!start || !end || start.type !== ytext || end.type !== ytext) return null;
		if (start.index > end.index) return null;
		if (text.slice(start.index, end.index) !== splice[expectedContent]) return null;
		resolved.push({
			from: start.index,
			to: end.index,
			deleted: splice.deleted,
			insert: splice.insert,
		});
	}
	return resolved;
}

function deltaToPositionedChanges(
	delta: Array<{ retain?: number; insert?: string | object; delete?: number }>,
): PositionedChange[] | null {
	const changes: PositionedChange[] = [];
	let cursor = 0;
	let block: PositionedChange | null = null;
	const flush = () => {
		if (!block) return;
		changes.push(block);
		block = null;
	};

	for (const part of delta) {
		if (part.retain !== undefined) {
			flush();
			cursor += part.retain;
			continue;
		}
		if (!block) block = { from: cursor, to: cursor, insert: "" };
		if (part.delete !== undefined) {
			block.to += part.delete;
			cursor += part.delete;
		}
		if (part.insert !== undefined) {
			if (typeof part.insert !== "string") return null;
			block.insert += part.insert;
		}
	}
	flush();
	return changes;
}

/** Project the remote CRDT's structural delta from the pinned base. */
export function projectRemoteChanges(
	remoteDoc: Y.Doc,
	capture: CapturedMachineEditDiff,
): PositionedChange[] | null {
	const projection = new Y.Doc({ gc: false });
	try {
		Y.applyUpdate(projection, capture.baseUpdate);
		let delta: Array<{
			retain?: number;
			insert?: string | object;
			delete?: number;
		}> | null = null;
		projection.getText("contents").observe((event) => {
			delta = event.delta as typeof delta;
		});
		const update = Y.encodeStateAsUpdate(remoteDoc, capture.baseStateVector);
		Y.applyUpdate(projection, update, remoteDoc);
		return delta === null ? [] : deltaToPositionedChanges(delta);
	} finally {
		projection.destroy();
	}
}

export function remoteDocMatchesMachineEdit(
	remoteDoc: Y.Doc,
	capture: CapturedMachineEditDiff,
): boolean {
	const changes = projectRemoteChanges(remoteDoc, capture);
	if (!changes) return false;
	return capture.splices.every((splice) =>
		changes.some(
			(change) =>
				change.from === splice.baseFrom &&
				change.to === splice.baseTo &&
				change.insert === splice.insert,
		),
	);
}

/** Return the CM6 change indexes that exactly carry the captured operation. */
export function matchCapturedPositionedChanges(
	doc: Y.Doc,
	capture: CapturedMachineEditDiff,
	changes: PositionedChange[],
	usePinnedCoordinates = false,
): Set<number> | null {
	const expected = usePinnedCoordinates
		? capture.splices.map((splice) => ({
				from: splice.baseFrom,
				to: splice.baseTo,
				deleted: splice.deleted,
				insert: splice.insert,
			}))
		: resolveMachineEditSplices(doc, capture);
	if (!expected) return null;

	const matched = new Set<number>();
	for (const splice of expected) {
		const index = changes.findIndex(
			(change, candidateIndex) =>
				!matched.has(candidateIndex) &&
				change.from === splice.from &&
				change.to === splice.to &&
				change.insert === splice.insert,
		);
		if (index < 0) return null;
		matched.add(index);
	}
	return matched;
}
