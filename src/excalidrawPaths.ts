/** Obsidian Excalidraw plugin stores drawings as `*.excalidraw.md`. */
export function isExcalidrawPath(path: string): boolean {
	return path.toLowerCase().endsWith(".excalidraw.md");
}
