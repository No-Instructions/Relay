import type { PositionedChange } from "../types";

export interface BufferedCM6Edit {
	changes: PositionedChange[];
	docText: string;
}

export interface BufferedCM6ReplayEvent {
	type: "CM6_CHANGE";
	changes: PositionedChange[];
	docText: string;
	viewId: string;
}

export function buildBufferedCM6ReplayEvents(
	pendingEdits: BufferedCM6Edit[],
	viewId: string,
): BufferedCM6ReplayEvent[] {
	return pendingEdits.map((edit) => ({
		type: "CM6_CHANGE",
		changes: edit.changes,
		docText: edit.docText,
		viewId,
	}));
}
