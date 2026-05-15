jest.mock(
	"obsidian",
	() => ({
		TFile: class TFile {},
		TFolder: class TFolder {},
	}),
	{ virtual: true },
);

import { TFile, TFolder } from "obsidian";
import { SyncFile } from "../src/SyncFile";
import { SyncFolder } from "../src/SyncFolder";
import { SyncType } from "../src/SyncTypes";

function makeSharedFolder(abstractFile: TFile | TFolder | null = null) {
	const sharedFolder = {
		relayId: "relay-guid",
		guid: "folder-guid",
		connected: true,
		vault: {
			getAbstractFileByPath: jest.fn(() => abstractFile),
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
		subscribe: jest.fn(() => jest.fn()),
		trashFile: jest.fn(() => Promise.resolve()),
		isPendingDelete: jest.fn(() => false),
	} as any;

	return sharedFolder;
}

function makeSyncFile(abstractFile: TFile | null = null) {
	const sharedFolder = makeSharedFolder(abstractFile);
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

	test("delete uses FileManager trash preferences", async () => {
		const tfile = new TFile();
		const { file, sharedFolder } = makeSyncFile(tfile);
		file.caf = {
			clear: jest.fn(() => Promise.resolve()),
			destroy: jest.fn(),
		} as any;

		await file.delete();

		expect(file.caf.clear).toHaveBeenCalled();
		expect(sharedFolder.trashFile).toHaveBeenCalledWith(tfile);
	});
});

describe("SyncFolder", () => {
	test("delete uses FileManager trash preferences", async () => {
		const tfolder = new TFolder();
		const sharedFolder = makeSharedFolder(tfolder);
		const folder = new SyncFolder("/assets", "folder-guid", sharedFolder);

		await folder.delete();

		expect(sharedFolder.trashFile).toHaveBeenCalledWith(tfolder);
	});
});
