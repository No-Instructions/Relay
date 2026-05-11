import {
	errorFromUnknown,
	formatUserFacingError,
} from "../../src/UserFacingError";

describe("formatUserFacingError", () => {
	test("uses error messages directly", () => {
		expect(formatUserFacingError(new Error("Network unavailable"))).toBe(
			"Network unavailable",
		);
	});

	test("extracts nested object messages", () => {
		expect(
			formatUserFacingError({
				response: {
					data: {
						message: "Storage quota exceeded",
					},
				},
			}),
		).toBe("Storage quota exceeded");
	});

	test("extracts JSON encoded messages", () => {
		expect(
			formatUserFacingError('{"error":{"message":"Permission denied"}}'),
		).toBe("Permission denied");
	});

	test("extracts Android bridge error payload messages", () => {
		expect(
			formatUserFacingError({
				name: "Error",
				message: "File does not exist",
				stack:
					"Error at returnResult (http://localhost/:915:32) at win.androidBridge.onmessage (http://localhost/:890:21)",
			}),
		).toBe("File does not exist");
	});

	test("extracts server rejection messages from structured error payloads", () => {
		expect(
			formatUserFacingError({
				name: "Error",
				message: "Max file size is 20MB",
				stack:
					"Error: Max file size is 20MB at SyncFile.push (plugin:system3-relay:27022:15)",
			}),
		).toBe("Max file size is 20MB");
	});

	test("uses status details when no message is available", () => {
		expect(
			formatUserFacingError({
				status: 503,
				statusText: "Service Unavailable",
			}),
		).toBe("Request failed with status 503: Service Unavailable");
	});

	test("falls back instead of showing object string output", () => {
		expect(formatUserFacingError({})).toBe("Sync failed");
		expect(formatUserFacingError("[object Object]")).toBe("Sync failed");
	});

	test("removes internal sync prefixes and guids from document sync failures", () => {
		const error = new Error(
			"[syncDocument] Document sync failed: /Folder/note.md (document-guid)",
		);

		expect(formatUserFacingError(error)).toBe("Unable to sync note.md");
		expect(errorFromUnknown(error).message).toBe("Unable to sync note.md");
	});
});
