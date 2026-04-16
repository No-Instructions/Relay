"use strict";

import { trackPromise } from "./trackPromise";

/**
 * Register a promise to be awaited before plugin re-enable during reload.
 * No-op during normal Obsidian unload (app._reloadAwait will be undefined).
 *
 * Optional `label` tracks the promise in the active PromiseTracker so stuck
 * teardown work can be correlated with the instance that registered it.
 */
export function awaitOnReload(p: Promise<void>, label?: string): void {
	const tracked = label ? trackPromise(label, p) : p;
	const awaited = tracked.catch((error) => {
		console.error(
			`[Relay] reloadAwait promise rejected${label ? ` (${label})` : ""}:`,
			error,
		);
	});
	if (typeof window !== 'undefined') {
		(window as any).app?._reloadAwait?.push(awaited);
	}
}
