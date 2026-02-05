"use strict";

/**
 * Register a promise to be awaited before plugin re-enable during reload.
 * No-op during normal Obsidian unload (app._reloadAwait will be undefined).
 */
export function awaitOnReload(p: Promise<void>): void {
	(window as any).app?._reloadAwait?.push(p);
}
