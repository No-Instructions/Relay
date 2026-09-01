export const FOLDER_SUGGEST_ROW_HEIGHT = 40;
export const FOLDER_SUGGEST_CONTAINER_PADDING = 8;
export const FOLDER_SUGGEST_VISIBLE_ROWS = 7;

export function folderSuggestHeight(suggestionCount: number): number {
	return Math.min(
		suggestionCount * FOLDER_SUGGEST_ROW_HEIGHT +
			FOLDER_SUGGEST_CONTAINER_PADDING,
		FOLDER_SUGGEST_VISIBLE_ROWS * FOLDER_SUGGEST_ROW_HEIGHT +
			FOLDER_SUGGEST_CONTAINER_PADDING,
	);
}
