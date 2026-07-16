import { Document } from "../Document";

/**
 * Pure UI rendering interface for updating Obsidian views when document changes occur.
 * Implementations should be side-effect free and only update UI components.
 */
export interface ViewRenderer {
	/**
	 * Update UI components based on document state and view mode.
	 * This method should be pure and have no side effects.
	 * 
	 * @param document - The document containing the updated state
	 * @param viewMode - Current view mode (e.g., "preview", "source", "live-preview")
	 */
	render(document: Document, viewMode: string): void;

	/** Queue a coalesced render when synchronous work is unsafe for the caller. */
	requestRender?(): void;
	
	/**
	 * Clean up any UI elements or listeners when the renderer is no longer needed.
	 */
	destroy(): void;
}
