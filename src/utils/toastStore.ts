import { writable } from "svelte/store";

export interface ToastMessage {
	message: string;
	details?: string;
	type?: "error" | "warning" | "info" | "success";
	visible: boolean;
	autoDismiss?: number;
	source?: "client" | "server";
}

// Global toast store
export const toastStore = writable<{ [key: string]: ToastMessage }>({});
const expiryTimers = new Map<string, number>();

export function showToast(
	key: string,
	message: string,
	details?: string,
	type: "error" | "warning" | "info" | "success" = "error",
	autoDismiss?: number,
	source: "client" | "server" = "client",
) {
	const previous = expiryTimers.get(key);
	if (previous !== undefined) window.clearTimeout(previous);
	expiryTimers.delete(key);
	const duration = autoDismiss ?? 5000;
	toastStore.update((toasts) => ({
		...toasts,
		[key]: {
			message,
			details,
			type,
			visible: true,
			autoDismiss: duration,
			source,
		},
	}));
	// Notification lifetime belongs to the store, including while settings
	// is closed and there is no mounted Toast component.
	if (duration > 0) expiryTimers.set(key, window.setTimeout(() => hideToast(key), duration));
}

export function hideToast(key: string) {
	const timer = expiryTimers.get(key);
	if (timer !== undefined) window.clearTimeout(timer);
	expiryTimers.delete(key);
	toastStore.update((toasts) => {
		const remaining = { ...toasts };
		delete remaining[key];
		return remaining;
	});
}

/**
 * Show a server-driven toast message
 * Typically called when receiving error responses or server notifications
 */
export function showServerToast(
	key: string,
	message: string,
	details?: string,
	type: "error" | "warning" | "info" | "success" = "error",
	autoDismiss?: number,
) {
	showToast(key, message, details, type, autoDismiss, "server");
}

/**
 * Parse server error response and show appropriate toast
 * Example: HTTP 403 with custom message from server
 */
interface ServerErrorLike {
	status?: number;
	message?: string;
	body?: { message?: string; details?: string };
}

export function handleServerError(
	error: unknown,
	fallbackMessage: string = "An error occurred",
) {
	const key = `server-error-${Date.now()}`;
	const err = (error ?? {}) as ServerErrorLike;

	if (err.status === 403) {
		// Server sent permission denial
		const serverMessage =
			err.body?.message || err.message || "Permission denied";
		const serverDetails = err.body?.details;
		showServerToast(key, serverMessage, serverDetails, "error", 7000);
	} else if (err.status !== undefined && err.status >= 400 && err.status < 500) {
		// Client error with potential server message
		const serverMessage =
			err.body?.message || err.message || fallbackMessage;
		showServerToast(key, serverMessage, undefined, "error", 5000);
	} else if (err.status !== undefined && err.status >= 500) {
		// Server error
		showServerToast(key, "Server error occurred", err.message, "error", 8000);
	} else {
		// Unknown error
		showServerToast(key, fallbackMessage, err.message, "error", 5000);
	}
}
