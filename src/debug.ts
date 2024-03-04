// CurryLog is a way to add tagged logging that is stripped in production

declare const BUILD_TYPE: string;

// Define two versions of curryLog
function curryLogDebug(initialText: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (...args: any[]) => console.log(initialText, ": ", ...args);
}

function curryLogProd(initialText: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (...args: any[]) => {};
}
const debug = BUILD_TYPE === "debug";
export const curryLog = debug ? curryLogDebug : curryLogProd;
