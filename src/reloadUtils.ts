"use strict";

import { trackPromise } from "./trackPromise";
import { curryLog } from "./debug";

const error = curryLog("[asyncCleanup]", "error");

/**
 * Track background cleanup work so failures are logged instead of becoming
 * unhandled promise rejections.
 */
export function trackAsyncCleanup(p: Promise<void>, label?: string): void {
	const tracked = label ? trackPromise(label, p) : p;
	void tracked.catch((err) => {
		error(`rejected${label ? ` (${label})` : ""}`, err);
	});
}
