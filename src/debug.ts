// CurryLog is a way to add tagged logging that is stripped in production

import { Notice } from "obsidian";

declare const BUILD_TYPE: string;

export const RelayInstances = new WeakMap();
let debugging = false;

export function setDebugging(debug: boolean) {
	debugging = debug;
}

function toastDebug(error: Error): Error {
	new Notice(error.name + "\n" + error.message);
	return error;
}
function toastProd(error: Error): Error {
	new Notice(error.name + ":\nAn error has occurred, please reload Obsidian.");
	return error;
}

export function curryLog(
	initialText: string,
	level: "debug" | "warn" | "log" | "error" = "log",
) {
	if (debugging) {
		return (...args: unknown[]) => console[level](initialText, ": ", ...args);
	}
	return (...args: unknown[]) => {};
}

const debug = BUILD_TYPE === "debug";
export const toast = debug ? toastDebug : toastProd;
