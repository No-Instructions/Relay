jest.mock("src/customFetch", () => ({ customFetch: jest.fn() }));
jest.mock("pocketbase", () => ({
	__esModule: true,
	default: jest.fn().mockImplementation(() => ({
		cancelAllRequests: jest.fn(),
	})),
}));
jest.mock("src/S3RN", () => ({
	S3RN: { encode: jest.fn(() => "s3rn:relay:test:doc:test") },
}));

import { ContentAddressedStore } from "src/CAS";
import { customFetch } from "src/customFetch";
import type { SyncFile } from "src/SyncFile";
import type { SharedFolder } from "src/SharedFolder";

const mockFetch = customFetch as jest.Mock;

function makeStore(): ContentAddressedStore {
	const sharedFolder = {
		path: "test-folder",
		loginManager: {
			getEndpointManager: () => ({ getAuthUrl: () => "https://auth.example" }),
			authStore: {},
		},
		tokenStore: {
			getFileToken: jest.fn(async () => ({
				baseUrl: "https://relay.example/f/doc",
				token: "tok",
			})),
		},
	} as unknown as SharedFolder;
	return new ContentAddressedStore(sharedFolder, {
		transferRetryDelaysMs: [0, 0],
	});
}

function makeSyncFile(): SyncFile {
	return {
		caf: {
			read: async () => new TextEncoder().encode("svg bytes").buffer,
			hash: async () => "abc123",
		},
		s3rn: {},
		mimetype: "image/svg+xml",
		guid: "test-guid",
	} as unknown as SyncFile;
}

function okJson(payload: object): Response {
	return {
		ok: true,
		status: 200,
		json: async () => payload,
	} as unknown as Response;
}

function okPut(): Response {
	return { ok: true, status: 200 } as unknown as Response;
}

beforeEach(() => {
	mockFetch.mockReset();
});

describe("writeFile retry", () => {
	it("retries an upload whose transport died with an unrecognized error", async () => {
		mockFetch
			.mockRejectedValueOnce(
				new TypeError("some transport failure no pattern knows about"),
			)
			.mockResolvedValueOnce(okJson({ uploadUrl: "https://s3.example/put" }))
			.mockResolvedValueOnce(okPut());
		await expect(makeStore().writeFile(makeSyncFile())).resolves.toBeUndefined();
		expect(mockFetch).toHaveBeenCalledTimes(3);
	});

	it("retries when the presigned PUT itself dies mid-flight", async () => {
		mockFetch
			.mockResolvedValueOnce(okJson({ uploadUrl: "https://s3.example/put" }))
			.mockRejectedValueOnce(new Error("socket hang up"))
			.mockResolvedValueOnce(okJson({ uploadUrl: "https://s3.example/put" }))
			.mockResolvedValueOnce(okPut());
		await expect(makeStore().writeFile(makeSyncFile())).resolves.toBeUndefined();
		expect(mockFetch).toHaveBeenCalledTimes(4);
	});

	it("does not retry an aborted upload", async () => {
		mockFetch.mockRejectedValue(
			new DOMException("The operation was aborted.", "AbortError"),
		);
		await expect(makeStore().writeFile(makeSyncFile())).rejects.toThrow();
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("does not retry a policy refusal", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 403,
			text: async () => "",
		} as unknown as Response);
		await expect(makeStore().writeFile(makeSyncFile())).rejects.toThrow();
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("gives up after the retry schedule is exhausted", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNRESET"));
		await expect(makeStore().writeFile(makeSyncFile())).rejects.toThrow();
		// initial attempt + one per schedule entry ([0, 0] -> 3 total)
		expect(mockFetch).toHaveBeenCalledTimes(3);
	});
});
