jest.mock(
	"obsidian",
	() => ({
		TFile: class TFile {},
	}),
	{ virtual: true },
);

import { SyncFile } from "../src/SyncFile";
import { SyncType } from "../src/SyncTypes";

function makeSyncFile() {
	const sharedFolder = {
		relayId: "relay-guid",
		guid: "folder-guid",
		connected: true,
		vault: {
			getAbstractFileByPath: jest.fn(() => null),
		},
		getPath: jest.fn((path: string) => `Shared${path}`),
		syncStore: {
			canSync: jest.fn(() => true),
			getMeta: jest.fn(() => undefined),
			pendingUpload: {
				has: jest.fn(() => true),
			},
			typeRegistry: {
				getTypeForPath: jest.fn(() => SyncType.Image),
			},
		},
		cas: {
			writeFile: jest.fn(),
		},
		markUploaded: jest.fn(),
	} as any;

	const file = new SyncFile(
		"/image.png",
		"file-guid",
		{} as any,
		sharedFolder,
	);
	file.caf = {
		hash: jest.fn(() => Promise.resolve("hash")),
		destroy: jest.fn(),
	} as any;

	return { file, sharedFolder };
}

describe("SyncFile", () => {
	test("push rejects upload failures without marking uploaded", async () => {
		const { file, sharedFolder } = makeSyncFile();
		sharedFolder.cas.writeFile.mockRejectedValue(new Error("Out of storage"));

		await expect(file.push()).rejects.toThrow("Out of storage");

		expect(file.uploadError).toBe("Out of storage");
		expect(sharedFolder.markUploaded).not.toHaveBeenCalled();
	});

	test("push leaves successful metadata marking to the caller", async () => {
		const { file, sharedFolder } = makeSyncFile();
		file.uploadError = "previous error";
		sharedFolder.cas.writeFile.mockResolvedValue(undefined);

		await expect(file.push()).resolves.toBeUndefined();

		expect(file.uploadError).toBeUndefined();
		expect(sharedFolder.markUploaded).not.toHaveBeenCalled();
	});
});
