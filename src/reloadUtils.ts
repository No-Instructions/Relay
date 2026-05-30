"use strict";

import { trackPromise } from "./trackPromise";
import { curryLog } from "./debug";

const error = curryLog("[asyncCleanup]", "error");

type ReloadWaitWindow = Window & {
	app?: {
		_reloadAwait?: unknown;
	};
};

function addToReloadWaitList(p: Promise<void>): void {
	if (typeof window === "undefined") return;
	const reloadAwait = (window as ReloadWaitWindow).app?._reloadAwait;
	if (Array.isArray(reloadAwait)) {
		reloadAwait.push(p);
	}
}

/**
 * Track background cleanup work so failures are logged instead of becoming
 * unhandled promise rejections.
 */
export function trackAsyncCleanup(p: Promise<void>, label?: string): void {
	const tracked = label ? trackPromise(label, p) : p;
	addToReloadWaitList(tracked);
	void tracked.catch((err) => {
		error(`rejected${label ? ` (${label})` : ""}`, err);
	});
}
