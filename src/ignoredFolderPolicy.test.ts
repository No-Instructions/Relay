import {
	classifyRenameSyncAction,
	collectIgnoredRemoteEntries,
	isContainedVaultPath,
	isIgnoredVaultPath,
	isIgnoredVirtualPath,
} from "./ignoredFolderPolicy";
import {
	SyncType,
	makeCanvasMeta,
	makeDocumentMeta,
	makeFileMeta,
	makeFolderMeta,
} from "./SyncTypes";

describe("ignored folder policy", () => {
	test("matches exact ignored virtual path segments", () => {
		expect(isIgnoredVirtualPath("_private")).toBe(true);
		expect(isIgnoredVirtualPath("folder/_private/note.md")).toBe(true);
		expect(isIgnoredVirtualPath("/_private/note.md")).toBe(true);
		expect(isIgnoredVirtualPath("folder\\_private\\note.md")).toBe(true);
		expect(isIgnoredVirtualPath("_private.md")).toBe(false);
		expect(isIgnoredVirtualPath("_Private")).toBe(false);
		expect(isIgnoredVirtualPath("my_private")).toBe(false);
	});

	test("supports custom ignored folder names", () => {
		expect(isIgnoredVirtualPath("folder/_secret/note.md", "_secret")).toBe(true);
		expect(isIgnoredVirtualPath("folder/_private/note.md", "_secret")).toBe(false);
	});

	test("keeps shared folder containment separate from ignored-path checks", () => {
		expect(isContainedVaultPath("03-impression/_private/note.md", "03-impression")).toBe(
			true,
		);
		expect(isIgnoredVaultPath("03-impression/_private/note.md", "03-impression")).toBe(
			true,
		);
		expect(isIgnoredVaultPath("03-impression/public/note.md", "03-impression")).toBe(
			false,
		);
	});

	test.each([
		[
			"remove-sync-metadata",
			{
				oldInSharedFolder: true,
				oldIgnored: false,
				newInSharedFolder: true,
				newIgnored: true,
			},
		],
		[
			"upload",
			{
				oldInSharedFolder: true,
				oldIgnored: true,
				newInSharedFolder: true,
				newIgnored: false,
			},
		],
		[
			"move-sync-metadata",
			{
				oldInSharedFolder: true,
				oldIgnored: false,
				newInSharedFolder: true,
				newIgnored: false,
			},
		],
		[
			"ignore",
			{
				oldInSharedFolder: true,
				oldIgnored: true,
				newInSharedFolder: true,
				newIgnored: true,
			},
		],
	] as const)("classifies rename as %s", (expected, input) => {
		expect(classifyRenameSyncAction(input)).toBe(expected);
	});

	test("collects ignored remote metadata and sorts children before parents", () => {
		const entries = collectIgnoredRemoteEntries([
			["_private", makeFolderMeta("folder-guid")],
			["_private/note.md", makeDocumentMeta("doc-guid")],
			["_private/board.canvas", makeCanvasMeta("canvas-guid")],
			[
				"_private/assets/image.png",
				makeFileMeta(SyncType.Image, "image-guid", "image/png", "hash", 1),
			],
			["_private.md", makeDocumentMeta("public-guid")],
			["_Private/note.md", makeDocumentMeta("case-guid")],
			["my_private/note.md", makeDocumentMeta("prefix-guid")],
		]);

		expect(entries.map((entry) => entry.path)).toEqual([
			"_private/assets/image.png",
			"_private/board.canvas",
			"_private/note.md",
			"_private",
		]);
		expect(entries.map((entry) => entry.guid)).toEqual([
			"image-guid",
			"canvas-guid",
			"doc-guid",
			"folder-guid",
		]);
	});
});
