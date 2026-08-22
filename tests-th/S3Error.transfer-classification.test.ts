import {
	S3ApiError,
	isRetryableS3Error,
	s3ApiErrorFromResponse,
	s3TransferFailureFromUnknown,
} from "src/S3Error";

describe("s3TransferFailureFromUnknown", () => {
	it("classifies an unrecognized no-response failure as retryable", () => {
		const classified = s3TransferFailureFromUnknown(
			new TypeError("some transport failure no pattern knows about"),
			"upload attachment",
		);
		expect(classified).toBeInstanceOf(S3ApiError);
		expect(isRetryableS3Error(classified)).toBe(true);
		expect(classified?.code).toBe("NetworkingError");
	});

	it("classifies a non-Error throw as retryable", () => {
		const classified = s3TransferFailureFromUnknown("connection dropped", "upload attachment");
		expect(isRetryableS3Error(classified)).toBe(true);
	});

	it("returns null for an AbortError DOMException", () => {
		expect(
			s3TransferFailureFromUnknown(
				new DOMException("The operation was aborted.", "AbortError"),
			),
		).toBeNull();
	});

	it("returns null for abort-shaped messages", () => {
		expect(
			s3TransferFailureFromUnknown(new Error("The user aborted a request.")),
		).toBeNull();
	});

	it("never re-wraps an already-classified S3ApiError", () => {
		const original = s3ApiErrorFromResponse(403, "", "upload attachment");
		expect(s3TransferFailureFromUnknown(original)).toBeNull();
	});
});

describe("404 user message", () => {
	it("names missing content instead of the generic fallback", () => {
		const error = s3ApiErrorFromResponse(404, "", "download attachment url");
		expect(error.message).toBe("Attachment content not found in storage.");
		expect(error.retryable).toBe(false);
	});
});
