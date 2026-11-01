declare const GIT_TAG: string;

/** Permanent documentation IDs; page keys describe the help needed at each entry point. */
const documentationIds = {
	// Name conflict dialog: names differ only in capitalization, including parent folders.
	// Explain why some devices cannot download both spellings and how to rename either safely.
	"name-conflicts": "3dfb637865e1be1",
} as const;

export type DocsPage = keyof typeof documentationIds;

export function getDocsUrl(page: DocsPage): string {
	return `https://docs.relay.md/${documentationIds[page]}?version=${encodeURIComponent(GIT_TAG)}`;
}

/** Opens help from a command or a link, preserving modified-click browser behavior. */
export function openDocs(page: DocsPage, event?: MouseEvent): void {
	if (event && (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
		return;
	}
	event?.preventDefault();
	const link = event?.currentTarget as HTMLAnchorElement | null | undefined;
	const ownerWindow = link?.ownerDocument.defaultView ?? window;
	ownerWindow.open(getDocsUrl(page), "_blank", "noopener,noreferrer");
}
