import * as Y from "yjs";
import { SyncStore } from "../src/SyncStore";
import {
	SyncType,
	isDocumentMeta,
	isSyncFolderMeta,
	makeDocumentMeta,
	makeFileMeta,
	makeFolderMeta,
} from "../src/SyncTypes";

import {
	NamespacedSettings,
	Settings,
	type StorageAdapter,
} from "../src/SettingsStorage";
import { describe, jest, beforeEach, test, expect } from "@jest/globals";
import { SyncSettingsManager, type SyncFlags } from "../src/SyncSettings";

jest.mock("../src/Document", () => ({
	Document: class {},
}));

jest.mock("../src/SyncFolder", () => ({
	SyncFolder: class {},
}));

jest.mock("../src/debug", () => ({
	HasLogging: class MockHasLogging {
		debug = console.debug;
		log = console.log;
		warn = console.warn;
		error = console.error;
	},
	RelayInstances: new WeakMap(),
}));

class TestStorageAdapter implements StorageAdapter<any> {
	private data: any = null;

	async loadData() {
		return this.data;
	}

	async saveData(data: any) {
		this.data = data;
	}
}

interface TestSettings {
	sync: SyncFlags;
}

const internal = (store: SyncStore) => store as any;

describe("SyncStore", () => {
	let ydoc: Y.Doc;
	let store: SyncStore;
	let storage: TestStorageAdapter;
	let settings: Settings<TestSettings>;
	let syncSettings: NamespacedSettings<SyncFlags>;
	let syncSettingsManager: SyncSettingsManager;

	beforeEach(async () => {
		ydoc = new Y.Doc();
		storage = new TestStorageAdapter();
		settings = new Settings(storage, {});
		syncSettings = new NamespacedSettings(settings, "sync");
		syncSettingsManager = syncSettings.getChild<
			Record<keyof SyncFlags, boolean>,
			SyncSettingsManager
		>("sync", (settings, path) => new SyncSettingsManager(settings, path));

		await settings.load();
		store = new SyncStore(
			ydoc,
			"/test",
			new Map<string, string>(),
			syncSettingsManager,
		);
	});

	describe("Old client operations", () => {
		test("creates document in root folder", () => {
			const guid = "doc-123";
			const path = "test.md";

			store.migrateFile(guid, path);

			// Check overlay
			const overlayMeta = internal(store).overlay.get(path);
			expect(overlayMeta).toBeDefined();
			expect(overlayMeta?.id).toBe(guid);
			expect(overlayMeta?.type).toBe("markdown");

			// Before commit, shouldn't be in main storage
			expect(internal(store).meta.has(path)).toBeFalsy();

			// After commit, should be in main storage
			store.commit();
			expect(internal(store).meta.get(path)?.id).toBe(guid);
			expect(internal(store).meta.get(path)?.type).toBe("markdown");
		});

		test("creates document in nested folder", () => {
			const guid = "doc-456";
			const path = "folder1/folder2/test.md";

			store.migrateFile(guid, path);

			// Check that folders were created in overlay
			expect(internal(store).overlay.get("folder1")?.type).toBe("folder");
			expect(internal(store).overlay.get("folder1/folder2")?.type).toBe(
				"folder",
			);
			expect(internal(store).overlay.get(path)?.type).toBe("markdown");

			// After commit, folders and document should exist
			store.commit();
			expect(isSyncFolderMeta(store.getMeta("folder1"))).toBeTruthy();
			expect(isSyncFolderMeta(store.getMeta("folder1/folder2"))).toBeTruthy();
			expect(isDocumentMeta(store.getMeta(path))).toBeTruthy();
		});

		test("migrates legacy documents", async () => {
			// Setup legacy data
			internal(store).legacyIds.set("old1.md", "guid1");
			internal(store).legacyIds.set("folder/old2.md", "guid2");

			store.migrateUp();

			// Check that documents were migrated
			expect(isDocumentMeta(store.getMeta("old1.md")));
			expect(isDocumentMeta(store.getMeta("folder/old2.md"))).toBeTruthy();
			expect(isSyncFolderMeta(store.getMeta("folder"))).toBeTruthy();
		});

		test("legacy client folder rename updates paths for all file types", () => {
			// Set up initial state with both legacy docs and new files
			// Legacy client only knows about markdown files
			internal(store).legacyIds.set("old_folder/document.md", "doc-guid");

			// New client knows about all files including images
			store.migrateUp();
			store.commit();

			// Add some non-markdown files that legacy client doesn't track
			store.set(
				"old_folder/image.png",
				makeFileMeta(SyncType.Image, "img-guid", "image/png", "asdf-hash"),
			);
			store.set(
				"old_folder/data.pdf",
				makeFileMeta(SyncType.PDF, "pdf-guid", "application/pdf", "asdf-hash2"),
			);

			// Simulate legacy client renaming the folder
			// They only update the path for the markdown file they know about
			internal(store).legacyIds.delete("old_folder/document.md");
			internal(store).legacyIds.set("new_folder/document.md", "doc-guid");

			// Run migration to update folder structure
			store.migrateUp();
			store.commit();
			store.resolveAll();

			// Verify folder was renamed
			expect(store.has("old_folder")).toBeFalsy();
			expect(isSyncFolderMeta(store.getMeta("new_folder"))).toBeTruthy();

			// Verify markdown file moved correctly
			expect(store.has("old_folder/document.md")).toBeFalsy();
			expect(
				isDocumentMeta(store.getMeta("new_folder/document.md")),
			).toBeTruthy();
			expect(store.getMeta("new_folder/document.md")?.id).toBe("doc-guid");

			// Verify other files were also moved
			expect(store.has("old_folder/image.png")).toBeFalsy();
			expect(store.has("old_folder/data.pdf")).toBeFalsy();

			expect(store.getMeta("new_folder/image.png")?.id).toBe("img-guid");
			expect(store.getMeta("new_folder/data.pdf")?.id).toBe("pdf-guid");
		});

		test("remoteIds remains consistent during folder moves", () => {
			// Set up initial state
			internal(store).legacyIds.set("old_folder/document.md", "doc-guid");

			store.migrateUp();
			store.commit();

			// Add some non-markdown files
			store.set(
				"old_folder/image.png",
				makeFileMeta(SyncType.Image, "img-guid", "image/png", "asdf-hash"),
			);
			store.set(
				"old_folder/data.pdf",
				makeFileMeta(SyncType.PDF, "pdf-guid", "application/pdf", "asdf-hash2"),
			);

			// Capture initial set of remoteIds
			const initialIds = Array.from(store.remoteIds);

			// Simulate legacy client renaming the folder
			internal(store).legacyIds.delete("old_folder/document.md");
			internal(store).legacyIds.set("new_folder/document.md", "doc-guid");

			store.migrateUp();
			store.commit();

			// Capture final set of remoteIds
			const finalIds = Array.from(store.remoteIds);

			// IDs should be the same before and after move
			expect(finalIds).toHaveLength(initialIds.length);
			expect(new Set(finalIds)).toEqual(new Set(initialIds));

			// Verify each specific ID is still present
			expect(finalIds).toContain("doc-guid");
			expect(finalIds).toContain("img-guid");
			expect(finalIds).toContain("pdf-guid");
		});
	});

	test("new client folder moves preserve all file metadata", () => {
		// Set up initial folder structure using only new client operations
		store.set("old_folder", makeFolderMeta("folder-guid"));
		store.set("old_folder/doc.md", makeDocumentMeta("doc-guid"));
		store.set(
			"old_folder/image.png",
			makeFileMeta(SyncType.Image, "img-guid", "image/png", "asdf-hash"),
		);
		store.set(
			"old_folder/data.pdf",
			makeFileMeta(SyncType.PDF, "pdf-guid", "application/pdf", "asdf-hash2"),
		);

		// Perform folder move using new client move operation
		store.move("old_folder", "new_folder");
		store.resolveAll();

		// Verify folder was moved
		expect(store.has("old_folder")).toBeFalsy();
		expect(store.has("new_folder")).toBeTruthy();
		expect(store.getMeta("new_folder")?.id).toBe("folder-guid");

		// Verify all files were moved and maintain their IDs
		expect(store.getMeta("new_folder/doc.md")?.id).toBe("doc-guid");
		expect(store.getMeta("new_folder/image.png")?.id).toBe("img-guid");
		expect(store.getMeta("new_folder/data.pdf")?.id).toBe("pdf-guid");

		// Verify old paths don't exist
		expect(store.has("old_folder/doc.md")).toBeFalsy();
		expect(store.has("old_folder/image.png")).toBeFalsy();
		expect(store.has("old_folder/data.pdf")).toBeFalsy();
	});

	test("detects folder rename from parallel create/delete operations", () => {
		// Initial setup - folder with multiple files
		store.set("wub", makeFolderMeta("folder-guid"));
		store.set("wub/rename.md", makeDocumentMeta("doc-guid"));
		store.set(
			"wub/frogadog 1.png",
			makeFileMeta(SyncType.Image, "img1-guid", "image/png", "asdf-hash"),
		);
		store.set(
			"wub/Pasted image 20241031171351.png",
			makeFileMeta(SyncType.Image, "img2-guid", "image/png", "asdf-hash2"),
		);

		// Capture initial IDs
		const initialIds = Array.from(store.remoteIds);

		// Simulate parallel create/delete operations
		store.set("sub", makeFolderMeta("folder-guid")); // Same folder ID
		store.set("sub/rename.md", store.getMeta("wub/rename.md")!);
		store.set("sub/frogadog 1.png", store.getMeta("wub/frogadog 1.png")!);
		store.set(
			"sub/Pasted image 20241031171351.png",
			store.getMeta("wub/Pasted image 20241031171351.png")!,
		);

		store.delete("wub/frogadog 1.png");
		store.delete("wub/Pasted image 20241031171351.png");
		store.delete("wub/rename.md");
		store.delete("wub");

		// Verify IDs are preserved
		const finalIds = Array.from(store.remoteIds);
		expect(new Set(finalIds)).toEqual(new Set(initialIds));

		// Verify all files exist at new location with same IDs
		expect(store.getMeta("sub")?.id).toBe("folder-guid");
		expect(store.getMeta("sub/rename.md")?.id).toBe("doc-guid");
		expect(store.getMeta("sub/frogadog 1.png")?.id).toBe("img1-guid");
		expect(store.getMeta("sub/Pasted image 20241031171351.png")?.id).toBe(
			"img2-guid",
		);

		// Verify old locations are gone
		expect(store.has("wub")).toBeFalsy();
		expect(store.has("wub/rename.md")).toBeFalsy();
		expect(store.has("wub/frogadog 1.png")).toBeFalsy();
		expect(store.has("wub/Pasted image 20241031171351.png")).toBeFalsy();
	});

	test("legacy client folder rename generates only renames", () => {
		// Setup initial state
		store.set("grub", makeFolderMeta("folder-guid"));
		store.set("grub/nested", makeFolderMeta("nested-guid"));
		store.set("grub/rename.md", makeDocumentMeta("doc-guid"));
		store.set(
			"grub/Pasted image 20241031171351.png",
			makeFileMeta(SyncType.Image, "img1-guid", "image/png", "asdf-hash"),
		);
		store.set(
			"grub/nested/frogadog 1.png",
			makeFileMeta(SyncType.Image, "img2-guid", "image/png", "asdf-hash2"),
		);

		// Simulate legacy client renaming folder
		internal(store).legacyIds.delete("grub/rename.md");
		internal(store).legacyIds.set("bub/rename.md", "doc-guid");

		store.migrateUp();
		store.commit();
		store.resolveAll();

		// Verify everything moved (no recreates)
		expect(store.getMeta("bub")?.id).toBe("folder-guid");
		expect(store.getMeta("bub/rename.md")?.id).toBe("doc-guid");
		expect(store.getMeta("bub/Pasted image 20241031171351.png")?.id).toBe(
			"img1-guid",
		);
		expect(store.getMeta("bub/nested/frogadog 1.png")?.id).toBe("img2-guid");

		// Old paths should be gone
		expect(store.has("grub")).toBeFalsy();
		expect(store.has("grub/nested")).toBeFalsy();
		expect(store.has("grub/rename.md")).toBeFalsy();
		expect(store.has("grub/Pasted image 20241031171351.png")).toBeFalsy();
		expect(store.has("grub/nested/frogadog 1.png")).toBeFalsy();
	});

	describe("New client operations", () => {
		test("sync folder operations don't affect legacy data", () => {
			// Setup legacy document
			internal(store).legacyIds.set("old.md", "legacy-guid");

			// New client creates a folder
			store.set("new-folder", makeFolderMeta("folder-guid"));

			// Legacy data should remain unchanged
			expect(internal(store).legacyIds.get("old.md")).toBe("legacy-guid");
			expect(store.getMeta("old.md")).toBeDefined();
		});

		test("sync file operations don't affect legacy data", () => {
			// Setup legacy document
			internal(store).legacyIds.set("old.md", "legacy-guid");

			// New client creates a file
			store.set(
				"new-file.pdf",
				makeFileMeta(
					SyncType.PDF,
					"file-guid",
					"application/pdf",
					"asdf-hash1",
				),
			);

			// Legacy data should remain unchanged
			expect(internal(store).legacyIds.get("old.md")).toBe("legacy-guid");
			expect(store.getMeta("old.md")).toBeDefined();
		});
	});

	describe("Basic CRUD operations", () => {
		test("creates new markdown document", () => {
			const path = "test.md";
			store.new(path);
			expect(store.has(path)).toBeTruthy();
		});

		test("creates new binary file", () => {
			const path = "test.pdf";
			store.new(path);
			expect(store.has(path)).toBeTruthy();
		});

		test("creates new folder", () => {
			const path = "folder1";
			store.new(path);
			store.markUploaded(path, makeFolderMeta(path));

			expect(isSyncFolderMeta(store.getMeta(path))).toBeTruthy();
			expect(store.has(path)).toBeTruthy();
		});

		test("moves files correctly", () => {
			const oldPath = "test.md";
			const newPath = "folder/test.md";
			const guid = store.new(oldPath);
			store.markUploaded(oldPath, makeFolderMeta(guid));

			store.move(oldPath, newPath);
			store.resolveAll();

			expect(store.has(oldPath)).toBeFalsy();
			expect(store.has(newPath)).toBeTruthy();
		});

		test("deletes files correctly", () => {
			const path = "test.md";
			const guid = store.new(path);
			store.markUploaded(path, makeFolderMeta(guid));

			store.delete(path);

			expect(store.has(path)).toBeFalsy();
			expect(store.getMeta(path)).toBeUndefined();
		});
	});

	describe("Delete Set functionality", () => {
		test("deleteSet prevents access to marked paths", () => {
			const path = "test.md";
			const guid = store.new(path);
			store.markUploaded(path, makeDocumentMeta(guid));

			internal(store).deleteSet.add(path);

			expect(store.has(path)).toBeFalsy();
			expect(store.getMeta(path)).toBeUndefined();
		});

		test("commit clears deleteSet", () => {
			const path = "test.md";
			const guid = store.new(path);
			store.markUploaded(path, makeDocumentMeta(guid));
			internal(store).deleteSet.add(path);

			store.commit();

			expect(internal(store).deleteSet.size).toBe(0);
		});
	});

	describe("Remote ID handling", () => {
		test("remoteIds returns correct set of IDs", () => {
			console.warn(store.remoteIds);
			const guid1 = store.new("test1.md");
			store.markUploaded("test1.md", makeDocumentMeta(guid1));

			const guid2 = store.new("test2.md");
			store.markUploaded("test2.md", makeDocumentMeta(guid2));

			const guid3 = store.new("folder");
			store.markUploaded("folder", makeFolderMeta(guid3));

			const remoteIds = store.remoteIds;

			console.warn(remoteIds);
			expect(remoteIds.size).toBe(3);
			expect(remoteIds.has(guid1)).toBeTruthy();
			expect(remoteIds.has(guid2)).toBeTruthy();
			expect(remoteIds.has(guid3)).toBeTruthy();
		});

		test("remoteIds excludes deleted items", () => {
			const guid1 = store.new("test1.md");
			store.markUploaded("test1.md", makeDocumentMeta(guid1));

			const guid2 = store.new("test2.md");
			store.markUploaded("test2.md", makeDocumentMeta(guid2));

			store.delete("test2.md");

			const remoteIds = store.remoteIds;
			expect(remoteIds.size).toBe(1);
			expect(remoteIds.has(guid1)).toBeTruthy();
			expect(remoteIds.has(guid2)).toBeFalsy();
		});
	});

	describe("Path handling", () => {
		test("handles paths with special characters", () => {
			const path = "folder/test with spaces.md";
			const guid = store.new(path);
			const meta = makeDocumentMeta(guid);
			store.markUploaded(path, meta);

			expect(store.has(path)).toBeTruthy();
			expect(store.get(path)).toEqual(guid);
			expect(store.getMeta(path)).toEqual(meta);
		});
	});
	describe("Metadata cleanup", () => {
		test("delete removes metadata entry", () => {
			const path = "test.md";
			const guid = store.new(path);
			store.markUploaded(path, makeDocumentMeta(guid));

			expect(store.getMeta(path)).toBeDefined();
			store.delete(path);
			expect(store.getMeta(path)).toBeUndefined();
		});

		test("move operation preserves metadata for new path only", () => {
			const oldPath = "test.md";
			const newPath = "folder/test.md";
			const guid = store.new(oldPath);
			const meta = makeDocumentMeta(guid);
			store.markUploaded(oldPath, meta);

			store.move(oldPath, newPath);
			store.resolveAll();

			expect(store.getMeta(oldPath)).toBeUndefined();
			expect(store.getMeta(newPath)).toEqual(meta);
		});

		test("new operations replace old metadata completely", () => {
			const path = "test.md";
			const guid1 = store.new(path);
			store.markUploaded(path, makeDocumentMeta(guid1));

			const guid2 = store.new(path);
			const meta2 = makeDocumentMeta(guid2);
			store.markUploaded(path, meta2);

			expect(store.getMeta(path)).toEqual(meta2);
		});

		test("metadata entries are consistent", () => {
			const guid1 = store.new("test1.md");
			store.markUploaded("test1.md", makeDocumentMeta(guid1));

			const guid2 = store.new("test2.md");
			store.markUploaded("test2.md", makeDocumentMeta(guid2));

			const folderGuid = store.new("folder");
			store.markUploaded("folder", makeFolderMeta(folderGuid));

			const guid3 = store.new("folder/test3.md");
			store.markUploaded("folder/test3.md", makeDocumentMeta(guid3));

			store.delete("test2.md");

			const expectedPaths = ["test1.md", "folder", "folder/test3.md"];

			expectedPaths.forEach((path) => {
				expect(store.getMeta(path)).toBeDefined();
			});

			let count = 0;
			store.forEach(() => count++);
			expect(count).toBe(3);
		});
		describe("Legacy file tree operations", () => {
			test("maintains parent folders when migrating nested documents", () => {
				// Setup legacy data - simulating nested files without folder entries
				internal(store).legacyIds.set("folder/subfolder/doc1.md", "guid1");
				internal(store).legacyIds.set("folder/subfolder/doc2.md", "guid2");

				// Trigger migration
				store.migrateUp();
				store.commit();

				// Verify all folders exist in metadata
				expect(isSyncFolderMeta(store.getMeta("folder"))).toBeTruthy();
				expect(
					isSyncFolderMeta(store.getMeta("folder/subfolder")),
				).toBeTruthy();

				// And documents exist
				expect(
					isDocumentMeta(store.getMeta("folder/subfolder/doc1.md")),
				).toBeTruthy();
				expect(
					isDocumentMeta(store.getMeta("folder/subfolder/doc2.md")),
				).toBeTruthy();
			});

			test("retains parent folders during partial tree operations", () => {
				// Setup initial tree
				internal(store).legacyIds.set("folder/subfolder/doc1.md", "guid1");
				internal(store).legacyIds.set("folder/subfolder/doc2.md", "guid2");

				store.migrateUp();
				store.commit();

				// Add new document through legacy path
				internal(store).legacyIds.set("folder/subfolder/doc3.md", "guid3");

				store.migrateUp();
				store.commit();

				// Verify folder structure remains intact
				expect(isSyncFolderMeta(store.getMeta("folder"))).toBeTruthy();
				expect(
					isSyncFolderMeta(store.getMeta("folder/subfolder")),
				).toBeTruthy();

				// And all documents exist
				expect(
					isDocumentMeta(store.getMeta("folder/subfolder/doc1.md")),
				).toBeTruthy();
				expect(
					isDocumentMeta(store.getMeta("folder/subfolder/doc2.md")),
				).toBeTruthy();
				expect(
					isDocumentMeta(store.getMeta("folder/subfolder/doc3.md")),
				).toBeTruthy();
			});

			test("forEach returns all entries including folders", () => {
				// Setup legacy data with nested structure
				internal(store).legacyIds.set("folder1/subfolder/doc1.md", "guid1");
				internal(store).legacyIds.set("folder1/subfolder/doc2.md", "guid2");

				store.migrateUp();
				store.commit();

				// Collect all paths returned by forEach
				const paths: string[] = [];
				store.forEach((meta, path) => {
					paths.push(path);
				});

				// Should include both files and folders
				expect(paths).toContain("folder1");
				expect(paths).toContain("folder1/subfolder");
				expect(paths).toContain("folder1/subfolder/doc1.md");
				expect(paths).toContain("folder1/subfolder/doc2.md");
				expect(paths.length).toBe(4);
			});
			test("maintains folder entries for existing files", () => {
				// Simulate legacy client creating files without folder entries
				internal(store).legacyIds.set("Untitled 4/new note 3.md", "guid1");
				internal(store).legacyIds.set("Untitled 4/Untitled 4.md", "guid2");

				store.migrateUp();
				store.commit();

				// Verify folder exists in metadata after migration
				expect(isSyncFolderMeta(store.getMeta("Untitled 4"))).toBeTruthy();

				// And files exist
				expect(
					isDocumentMeta(store.getMeta("Untitled 4/new note 3.md")),
				).toBeTruthy();
				expect(
					isDocumentMeta(store.getMeta("Untitled 4/Untitled 4.md")),
				).toBeTruthy();
			});
		});
	});

	describe("move operations", () => {
		test("basic move operation", () => {
			const oldPath = "test.md";
			const newPath = "renamed.md";
			const guid = store.new(oldPath);
			store.markUploaded(oldPath, makeDocumentMeta(guid));

			store.move(oldPath, newPath);
			store.resolveAll();

			expect(store.has(oldPath)).toBeFalsy();
			expect(store.has(newPath)).toBeTruthy();
			expect(store.get(newPath)).toBe(guid);
		});

		test("move handles pending uploads", () => {
			const oldPath = "upload.md";
			const newPath = "new-upload.md";
			const guid = store.new(oldPath); // This puts it in pendingUpload

			store.move(oldPath, newPath);
			store.resolveAll();

			expect(internal(store).pendingUpload.has(oldPath)).toBeFalsy();
			expect(internal(store).pendingUpload.get(newPath)).toBe(guid);
		});

		test("move preserves metadata in overlay", () => {
			const oldPath = "doc.md";
			const newPath = "new-doc.md";
			const meta = makeDocumentMeta("test-guid");

			internal(store).overlay.set(oldPath, meta);
			internal(store).legacyIds.set(oldPath, "test-guid");
			store.move(oldPath, newPath);
			store.resolveAll();

			expect(internal(store).overlay.get(newPath)).toEqual(meta);
			expect(internal(store).overlay.has(oldPath)).toBeFalsy();
		});

		test("move updates deleteSet entries", () => {
			const oldPath = "delete-me.md";
			const newPath = "also-delete-me.md";

			internal(store).deleteSet.add(oldPath);
			store.move(oldPath, newPath);
			store.resolveAll();

			expect(internal(store).deleteSet.has(oldPath)).toBeFalsy();
			expect(internal(store).deleteSet.has(newPath)).toBeTruthy();
		});

		test("move handles folder paths", () => {
			const oldPath = "folder/doc.md";
			const newPath = "new-folder/doc.md";
			const guid = store.new(oldPath);
			store.markUploaded(oldPath, makeDocumentMeta(guid));

			store.move(oldPath, newPath);
			store.resolveAll();

			expect(store.has(oldPath)).toBeFalsy();
			expect(store.has(newPath)).toBeTruthy();
			expect(store.get(newPath)).toBe(guid);
		});

		test("move handles fs delays", () => {
			const oldPath = "folder/doc.md";
			const newPath = "new-folder/doc.md";
			const guid = store.new(oldPath);
			store.markUploaded(oldPath, makeDocumentMeta(guid));

			store.move(oldPath, newPath);

			expect(store.has(oldPath)).toBeTruthy();
			expect(store.has(newPath)).toBeTruthy();
			expect(store.get(newPath)).toBe(guid);

			store.resolveMove(oldPath);

			expect(store.has(oldPath)).toBeFalsy();
		});
	});
});
