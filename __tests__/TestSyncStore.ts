import * as Y from "yjs";
import {
	SyncStore,
	makeFolderMeta,
	makeFileMeta,
	isDocument,
	isSyncFolder,
	isSyncFile,
	makeDocumentMeta,
} from "../src/SyncStore";
import { describe, jest, beforeEach, test, expect } from "@jest/globals";

jest.mock("../src/Document", () => ({
	Document: class {},
}));

jest.mock("../src/SyncFile", () => ({
	SyncFile: class {},
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
}));

const internal = (store: SyncStore) => store as any;

describe("SyncStore", () => {
	let ydoc: Y.Doc;
	let store: SyncStore;

	beforeEach(() => {
		ydoc = new Y.Doc();
		store = new SyncStore(ydoc, "/test");
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
			expect(isSyncFolder(store.get("folder1"))).toBeTruthy();
			expect(isSyncFolder(store.get("folder1/folder2"))).toBeTruthy();
			expect(isDocument(store.get(path))).toBeTruthy();
		});

		test("migrates legacy documents", async () => {
			// Setup legacy data
			internal(store).legacy_ids.set("old1.md", "guid1");
			internal(store).legacy_ids.set("folder/old2.md", "guid2");

			store.migrateUp();

			// Check that documents were migrated
			expect(isDocument(store.get("old1.md")));
			expect(isDocument(store.get("folder/old2.md"))).toBeTruthy();
			expect(isSyncFolder(store.get("folder"))).toBeTruthy();
		});

		test("legacy client folder rename updates paths for all file types", () => {
			// Set up initial state with both legacy docs and new files
			// Legacy client only knows about markdown files
			internal(store).legacy_ids.set("old_folder/document.md", "doc-guid");

			// New client knows about all files including images
			store.migrateUp();
			store.commit();

			// Add some non-markdown files that legacy client doesn't track
			store.set("old_folder/image.png", makeFileMeta("img-guid", "image/png"));
			store.set(
				"old_folder/data.pdf",
				makeFileMeta("pdf-guid", "application/pdf"),
			);

			// Simulate legacy client renaming the folder
			// They only update the path for the markdown file they know about
			internal(store).legacy_ids.delete("old_folder/document.md");
			internal(store).legacy_ids.set("new_folder/document.md", "doc-guid");

			// Run migration to update folder structure
			store.migrateUp();
			store.commit();

			// Verify folder was renamed
			expect(store.has("old_folder")).toBeFalsy();
			expect(isSyncFolder(store.get("new_folder"))).toBeTruthy();

			// Verify markdown file moved correctly
			expect(store.has("old_folder/document.md")).toBeFalsy();
			expect(isDocument(store.get("new_folder/document.md"))).toBeTruthy();
			expect(store.get("new_folder/document.md")?.id).toBe("doc-guid");

			// Verify other files were also moved
			expect(store.has("old_folder/image.png")).toBeFalsy();
			expect(store.has("old_folder/data.pdf")).toBeFalsy();

			expect(store.get("new_folder/image.png")?.id).toBe("img-guid");
			expect(store.get("new_folder/data.pdf")?.id).toBe("pdf-guid");
		});

		test("remoteIds remains consistent during folder moves", () => {
			// Set up initial state
			internal(store).legacy_ids.set("old_folder/document.md", "doc-guid");

			store.migrateUp();
			store.commit();

			// Add some non-markdown files
			store.set("old_folder/image.png", makeFileMeta("img-guid", "image/png"));
			store.set(
				"old_folder/data.pdf",
				makeFileMeta("pdf-guid", "application/pdf"),
			);

			// Capture initial set of remoteIds
			const initialIds = Array.from(store.remoteIds);

			// Simulate legacy client renaming the folder
			internal(store).legacy_ids.delete("old_folder/document.md");
			internal(store).legacy_ids.set("new_folder/document.md", "doc-guid");

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
		store.set("old_folder/image.png", makeFileMeta("img-guid", "image/png"));
		store.set(
			"old_folder/data.pdf",
			makeFileMeta("pdf-guid", "application/pdf"),
		);

		// Perform folder move using new client move operation
		store.move("old_folder", "new_folder");

		// Verify folder was moved
		expect(store.has("old_folder")).toBeFalsy();
		expect(store.has("new_folder")).toBeTruthy();
		expect(store.get("new_folder")?.id).toBe("folder-guid");

		// Verify all files were moved and maintain their IDs
		expect(store.get("new_folder/doc.md")?.id).toBe("doc-guid");
		expect(store.get("new_folder/image.png")?.id).toBe("img-guid");
		expect(store.get("new_folder/data.pdf")?.id).toBe("pdf-guid");

		// Verify old paths don't exist
		expect(store.has("old_folder/doc.md")).toBeFalsy();
		expect(store.has("old_folder/image.png")).toBeFalsy();
		expect(store.has("old_folder/data.pdf")).toBeFalsy();
	});

	test("detects folder rename from parallel create/delete operations", () => {
		// Initial setup - folder with multiple files
		store.set("wub", makeFolderMeta("folder-guid"));
		store.set("wub/rename.md", makeDocumentMeta("doc-guid"));
		store.set("wub/frogadog 1.png", makeFileMeta("img1-guid", "image/png"));
		store.set(
			"wub/Pasted image 20241031171351.png",
			makeFileMeta("img2-guid", "image/png"),
		);

		// Capture initial IDs
		const initialIds = Array.from(store.remoteIds);

		// Simulate parallel create/delete operations
		store.set("sub", makeFolderMeta("folder-guid")); // Same folder ID
		store.set("sub/rename.md", store.get("wub/rename.md")!);
		store.set("sub/frogadog 1.png", store.get("wub/frogadog 1.png")!);
		store.set(
			"sub/Pasted image 20241031171351.png",
			store.get("wub/Pasted image 20241031171351.png")!,
		);

		store.delete("wub/frogadog 1.png");
		store.delete("wub/Pasted image 20241031171351.png");
		store.delete("wub/rename.md");
		store.delete("wub");

		// Verify IDs are preserved
		const finalIds = Array.from(store.remoteIds);
		expect(new Set(finalIds)).toEqual(new Set(initialIds));

		// Verify all files exist at new location with same IDs
		expect(store.get("sub")?.id).toBe("folder-guid");
		expect(store.get("sub/rename.md")?.id).toBe("doc-guid");
		expect(store.get("sub/frogadog 1.png")?.id).toBe("img1-guid");
		expect(store.get("sub/Pasted image 20241031171351.png")?.id).toBe(
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
			makeFileMeta("img1-guid", "image/png"),
		);
		store.set(
			"grub/nested/frogadog 1.png",
			makeFileMeta("img2-guid", "image/png"),
		);

		// Simulate legacy client renaming folder
		internal(store).legacy_ids.delete("grub/rename.md");
		internal(store).legacy_ids.set("bub/rename.md", "doc-guid");

		store.migrateUp();
		store.commit();

		// Verify everything moved (no recreates)
		expect(store.get("bub")?.id).toBe("folder-guid");
		expect(store.get("bub/rename.md")?.id).toBe("doc-guid");
		expect(store.get("bub/Pasted image 20241031171351.png")?.id).toBe(
			"img1-guid",
		);
		expect(store.get("bub/nested/frogadog 1.png")?.id).toBe("img2-guid");

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
			internal(store).legacy_ids.set("old.md", "legacy-guid");

			// New client creates a folder
			store.set("new-folder", makeFolderMeta("folder-guid"));

			// Legacy data should remain unchanged
			expect(internal(store).legacy_ids.get("old.md")).toBe("legacy-guid");
			expect(store.get("old.md")).toBeDefined();
		});

		test("sync file operations don't affect legacy data", () => {
			// Setup legacy document
			internal(store).legacy_ids.set("old.md", "legacy-guid");

			// New client creates a file
			store.set("new-file.pdf", makeFileMeta("file-guid", "application/pdf"));

			// Legacy data should remain unchanged
			expect(internal(store).legacy_ids.get("old.md")).toBe("legacy-guid");
			expect(store.get("old.md")).toBeDefined();
		});
	});

	describe("Basic CRUD operations", () => {
		test("creates new markdown document", () => {
			const path = "test.md";
			const meta = store.new(path, false);

			expect(store.get(path)).toEqual(meta);
			expect(store.has(path)).toBeTruthy();
		});

		test("creates new binary file", () => {
			const path = "test.pdf";
			const meta = store.new(path, false);

			expect(isSyncFile(store.get(path))).toBeTruthy();
			expect(meta.mimetype).toBe("application/pdf");
			expect(store.has(path)).toBeTruthy();
		});

		test("creates new folder", () => {
			const path = "folder1";
			store.new(path, true);

			expect(isSyncFolder(store.get(path))).toBeTruthy();
			expect(store.has(path)).toBeTruthy();
		});

		test("moves files correctly", () => {
			const oldPath = "test.md";
			const newPath = "folder/test.md";
			const meta = store.new(oldPath, false);

			store.move(oldPath, newPath);

			expect(store.has(oldPath)).toBeFalsy();
			expect(store.has(newPath)).toBeTruthy();
			expect(store.get(newPath)).toEqual(meta);
		});

		test("deletes files correctly", () => {
			const path = "test.md";
			store.new(path, false);

			store.delete(path);

			expect(store.has(path)).toBeFalsy();
			expect(store.get(path)).toBeUndefined();
		});
	});

	describe("Delete Set functionality", () => {
		test("deleteSet prevents access to marked paths", () => {
			const path = "test.md";
			store.new(path, false);

			internal(store).deleteSet.add(path);

			expect(store.has(path)).toBeFalsy();
			expect(store.get(path)).toBeUndefined();
		});

		test("commit clears deleteSet", () => {
			const path = "test.md";
			store.new(path, false);
			internal(store).deleteSet.add(path);

			store.commit();

			expect(internal(store).deleteSet.size).toBe(0);
		});
	});

	describe("Remote ID handling", () => {
		test("remoteIds returns correct set of IDs", () => {
			const meta1 = store.new("test1.md", false);
			const meta2 = store.new("test2.md", false);
			const meta3 = store.new("folder", true);

			const remoteIds = store.remoteIds;

			expect(remoteIds.size).toBe(3);
			expect(remoteIds.has(meta1.id)).toBeTruthy();
			expect(remoteIds.has(meta2.id)).toBeTruthy();
			expect(remoteIds.has(meta3.id)).toBeTruthy();
		});

		test("remoteIds excludes deleted items", () => {
			const meta1 = store.new("test1.md", false);
			const meta2 = store.new("test2.md", false);

			store.delete("test2.md");

			const remoteIds = store.remoteIds;
			expect(remoteIds.size).toBe(1);
			expect(remoteIds.has(meta1.id)).toBeTruthy();
			expect(remoteIds.has(meta2.id)).toBeFalsy();
		});
	});

	describe("Path handling", () => {
		test("handles paths with special characters", () => {
			const path = "folder/test with spaces.md";
			const meta = store.new(path, false);

			expect(store.has(path)).toBeTruthy();
			expect(store.get(path)).toEqual(meta);
		});

		test("checkExtension correctly identifies file types", () => {
			expect(store.checkExtension("test.md", "md")).toBeTruthy();
			expect(store.checkExtension("test.pdf", "md")).toBeFalsy();
			expect(store.checkExtension("test", "md")).toBeFalsy();
		});
	});
	describe("Metadata cleanup", () => {
		test("delete removes metadata entry", () => {
			const path = "test.md";
			store.new(path, false);

			expect(store.get(path)).toBeDefined();
			store.delete(path);
			expect(store.get(path)).toBeUndefined();
		});

		test("move operation preserves metadata for new path only", () => {
			const oldPath = "test.md";
			const newPath = "folder/test.md";
			const meta = store.new(oldPath, false);

			store.move(oldPath, newPath);

			expect(store.get(oldPath)).toBeUndefined();
			expect(store.get(newPath)).toEqual(meta);
		});

		test("new operations replace old metadata completely", () => {
			const path = "test.md";
			store.new(path, false);
			const meta2 = store.new(path, false);

			expect(store.get(path)).toEqual(meta2);
		});

		test("metadata entries are consistent", () => {
			store.new("test1.md", false);
			store.new("test2.md", false);
			store.new("folder", true);
			store.new("folder/test3.md", false);

			store.delete("test2.md");

			const expectedPaths = ["test1.md", "folder", "folder/test3.md"];

			expectedPaths.forEach((path) => {
				expect(store.get(path)).toBeDefined();
			});

			let count = 0;
			store.forEach(() => count++);
			expect(count).toBe(3);
		});
		describe("Legacy file tree operations", () => {
			test("maintains parent folders when migrating nested documents", () => {
				// Setup legacy data - simulating nested files without folder entries
				internal(store).legacy_ids.set("folder/subfolder/doc1.md", "guid1");
				internal(store).legacy_ids.set("folder/subfolder/doc2.md", "guid2");

				// Trigger migration
				store.migrateUp();
				store.commit();

				// Verify all folders exist in metadata
				expect(isSyncFolder(store.get("folder"))).toBeTruthy();
				expect(isSyncFolder(store.get("folder/subfolder"))).toBeTruthy();

				// And documents exist
				expect(isDocument(store.get("folder/subfolder/doc1.md"))).toBeTruthy();
				expect(isDocument(store.get("folder/subfolder/doc2.md"))).toBeTruthy();
			});

			test("retains parent folders during partial tree operations", () => {
				// Setup initial tree
				internal(store).legacy_ids.set("folder/subfolder/doc1.md", "guid1");
				internal(store).legacy_ids.set("folder/subfolder/doc2.md", "guid2");

				store.migrateUp();
				store.commit();

				// Add new document through legacy path
				internal(store).legacy_ids.set("folder/subfolder/doc3.md", "guid3");

				store.migrateUp();
				store.commit();

				// Verify folder structure remains intact
				expect(isSyncFolder(store.get("folder"))).toBeTruthy();
				expect(isSyncFolder(store.get("folder/subfolder"))).toBeTruthy();

				// And all documents exist
				expect(isDocument(store.get("folder/subfolder/doc1.md"))).toBeTruthy();
				expect(isDocument(store.get("folder/subfolder/doc2.md"))).toBeTruthy();
				expect(isDocument(store.get("folder/subfolder/doc3.md"))).toBeTruthy();
			});

			test("forEach returns all entries including folders", () => {
				// Setup legacy data with nested structure
				internal(store).legacy_ids.set("folder1/subfolder/doc1.md", "guid1");
				internal(store).legacy_ids.set("folder1/subfolder/doc2.md", "guid2");

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
				internal(store).legacy_ids.set("Untitled 4/new note 3.md", "guid1");
				internal(store).legacy_ids.set("Untitled 4/Untitled 4.md", "guid2");

				store.migrateUp();
				store.commit();

				// Verify folder exists in metadata after migration
				expect(isSyncFolder(store.get("Untitled 4"))).toBeTruthy();

				// And files exist
				expect(isDocument(store.get("Untitled 4/new note 3.md"))).toBeTruthy();
				expect(isDocument(store.get("Untitled 4/Untitled 4.md"))).toBeTruthy();
			});
		});
	});
});
