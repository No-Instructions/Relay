// CurryLog is a way to add tagged logging that is stripped in production

import { Notice } from "obsidian";

declare const BUILD_TYPE: string;

function toastDebug(error: Error): Error {
	new Notice(error.name + "\n" + error.message);
	return error;
}
function toastProd(error: Error): Error {
	new Notice(
		error.name + ":\nAn error has occurred, please reload Obsidian."
	);
	return error;
}

// Define two versions of curryLog
function curryLogDebug(initialText: string) {
	return (...args: unknown[]) => console.log(initialText, ": ", ...args);
}

function curryLogProd(initialText: string) {
	return (...args: unknown[]) => {};
}
const debug = BUILD_TYPE === "debug";
export const curryLog = debug ? curryLogDebug : curryLogProd;
export const toast = debug ? toastDebug : toastProd;
