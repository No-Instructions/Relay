export const FOLDER_SUGGEST_ROW_HEIGHT = 40;
export const FOLDER_SUGGEST_CONTAINER_PADDING = 8;
export const FOLDER_SUGGEST_VISIBLE_ROWS = 7;
/** Space kept between the input and the list. */
export const FOLDER_SUGGEST_GAP = 2;
/** Space kept between the list and the window edge. */
export const FOLDER_SUGGEST_EDGE_MARGIN = 10;

export function folderSuggestHeight(suggestionCount: number): number {
	return Math.min(
		suggestionCount * FOLDER_SUGGEST_ROW_HEIGHT +
			FOLDER_SUGGEST_CONTAINER_PADDING,
		FOLDER_SUGGEST_VISIBLE_ROWS * FOLDER_SUGGEST_ROW_HEIGHT +
			FOLDER_SUGGEST_CONTAINER_PADDING,
	);
}

/** The input's vertical extent in the window the list is placed in. */
export interface FolderSuggestAnchor {
	top: number;
	bottom: number;
}

/**
 * Where the list hangs from its input. `below` gives a CSS top; `above`
 * gives a CSS bottom so the list keeps hugging the input when its content
 * is shorter than the allowed height.
 */
export type FolderSuggestPlacement =
	| { side: "below"; top: number; maxHeight: number }
	| { side: "above"; bottom: number; maxHeight: number };

/**
 * Place a list `listHeight` tall against `anchor` inside a window
 * `viewportHeight` tall. The list goes below the input when it fits there,
 * above when only that side has the room, and otherwise below, clipped to
 * the room that exists so it never extends past the window edge. An input
 * flush against the bottom of its window therefore opens upward instead of
 * off screen. At least one row always shows.
 */
export function placeFolderSuggest(
	anchor: FolderSuggestAnchor,
	viewportHeight: number,
	listHeight: number,
): FolderSuggestPlacement {
	const oneRow = FOLDER_SUGGEST_ROW_HEIGHT + FOLDER_SUGGEST_CONTAINER_PADDING;
	const roomBelow = viewportHeight - anchor.bottom - FOLDER_SUGGEST_GAP - FOLDER_SUGGEST_EDGE_MARGIN;
	const roomAbove = anchor.top - FOLDER_SUGGEST_GAP - FOLDER_SUGGEST_EDGE_MARGIN;
	if (listHeight <= roomBelow) {
		return { side: "below", top: anchor.bottom + FOLDER_SUGGEST_GAP, maxHeight: listHeight };
	}
	if (roomAbove > roomBelow) {
		return {
			side: "above",
			bottom: viewportHeight - anchor.top + FOLDER_SUGGEST_GAP,
			maxHeight: Math.max(oneRow, Math.min(listHeight, roomAbove)),
		};
	}
	return {
		side: "below",
		top: anchor.bottom + FOLDER_SUGGEST_GAP,
		maxHeight: Math.max(oneRow, Math.min(listHeight, roomBelow)),
	};
}
