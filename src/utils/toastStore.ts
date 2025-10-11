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

export function showToast(
	key: string,
	message: string,
	details?: string,
	type: "error" | "warning" | "info" | "success" = "error",
	autoDismiss?: number,
	source: "client" | "server" = "client",
) {
	toastStore.update((toasts) => ({
		...toasts,
		[key]: {
			message,
			details,
			type,
			visible: true,
			autoDismiss: autoDismiss ?? 5000,
			source,
		},
	}));
}

export function hideToast(key: string) {
	toastStore.update((toasts) => ({
		...toasts,
		[key]: { ...toasts[key], visible: false },
	}));
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
export function handleServerError(
	error: any,
	fallbackMessage: string = "An error occurred",
) {
	const key = `server-error-${Date.now()}`;

	if (error.status === 403) {
		// Server sent permission denial
		const serverMessage =
			error.body?.message || error.message || "Permission denied";
		const serverDetails = error.body?.details;
		showServerToast(key, serverMessage, serverDetails, "error", 7000);
	} else if (error.status >= 400 && error.status < 500) {
		// Client error with potential server message
		const serverMessage =
			error.body?.message || error.message || fallbackMessage;
		showServerToast(key, serverMessage, undefined, "error", 5000);
	} else if (error.status >= 500) {
		// Server error
		showServerToast(key, "Server error occurred", error.message, "error", 8000);
	} else {
		// Unknown error
		showServerToast(key, fallbackMessage, error.message, "error", 5000);
	}
}
