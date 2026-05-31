import {
	classifyRenameSyncAction,
	collectIgnoredRemoteEntries,
	findIgnoredRootForVirtualPath,
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
	test("matches paths under marker roots", () => {
		const roots = new Set(["secret", "nested/private"]);
		expect(isIgnoredVirtualPath("secret", roots)).toBe(true);
		expect(isIgnoredVirtualPath("secret/note.md", roots)).toBe(true);
		expect(isIgnoredVirtualPath("/nested/private/note.md", roots)).toBe(true);
		expect(isIgnoredVirtualPath("nested\\private\\note.md", roots)).toBe(true);
		expect(isIgnoredVirtualPath("secretary/note.md", roots)).toBe(false);
		expect(isIgnoredVirtualPath("nested/public/note.md", roots)).toBe(false);
	});

	test("keeps shared folder containment separate from ignored-path checks", () => {
		const roots = new Set(["secret"]);
		expect(isContainedVaultPath("03-impression/secret/note.md", "03-impression")).toBe(
			true,
		);
		expect(isIgnoredVaultPath("03-impression/secret/note.md", "03-impression", roots)).toBe(
			true,
		);
		expect(isIgnoredVaultPath("03-impression/public/note.md", "03-impression", roots)).toBe(
			false,
		);
	});

	test("always ignores the marker file itself", () => {
		expect(isIgnoredVirtualPath(".relayignore", new Set())).toBe(true);
		expect(isIgnoredVirtualPath("secret/.relayignore", new Set())).toBe(true);
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
			["secret", makeFolderMeta("folder-guid")],
			["secret/note.md", makeDocumentMeta("doc-guid")],
			["secret/board.canvas", makeCanvasMeta("canvas-guid")],
			[
				"secret/assets/image.png",
				makeFileMeta(SyncType.Image, "image-guid", "image/png", "hash", 1),
			],
			["secretary/note.md", makeDocumentMeta("public-guid")],
		], new Set(["secret"]));

		expect(entries.map((entry) => entry.path)).toEqual([
			"secret/assets/image.png",
			"secret/board.canvas",
			"secret/note.md",
			"secret",
		]);
		expect(entries.map((entry) => entry.guid)).toEqual([
			"image-guid",
			"canvas-guid",
			"doc-guid",
			"folder-guid",
		]);
	});

	test("finds the deepest marker root for a path", () => {
		const roots = new Set(["secret", "secret/deeper"]);
		expect(findIgnoredRootForVirtualPath("secret/deeper/note.md", roots)).toBe(
			"secret/deeper",
		);
		expect(findIgnoredRootForVirtualPath("secret/other.md", roots)).toBe("secret");
		expect(findIgnoredRootForVirtualPath("public/other.md", roots)).toBe(null);
	});
});
