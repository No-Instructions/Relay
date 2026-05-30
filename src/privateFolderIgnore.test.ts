import {
	DEFAULT_IGNORED_FOLDER_NAME,
	isValidIgnoredFolderName,
	normalizeIgnoredFolderName,
	pathContainsIgnoredFolderSegment,
} from "./privateFolderIgnore";

describe("pathContainsIgnoredFolderSegment", () => {
	test.each([
		"_private",
		"folder/_private",
		"folder/_private/note.md",
		"/_private/note.md",
		"folder\\_private\\note.md",
	])("matches ignored folder segment in %s", (path) => {
		expect(pathContainsIgnoredFolderSegment(path)).toBe(true);
	});

	test.each(["_private.md", "not_private", "_Private", "folder/my_private/note.md"])(
		"does not match non-private folder segment in %s",
		(path) => {
			expect(pathContainsIgnoredFolderSegment(path)).toBe(false);
		},
	);

	test("uses custom ignored folder name", () => {
		expect(pathContainsIgnoredFolderSegment("folder/_secret/note.md", "_secret")).toBe(
			true,
		);
		expect(pathContainsIgnoredFolderSegment("folder/_private/note.md", "_secret")).toBe(
			false,
		);
	});

	test.each(["", "   ", "nested/folder", "nested\\folder"])(
		"normalizes invalid setting %s to default",
		(name) => {
			expect(normalizeIgnoredFolderName(name)).toBe(DEFAULT_IGNORED_FOLDER_NAME);
		},
	);

	test("validates user-provided ignored folder names", () => {
		expect(isValidIgnoredFolderName("_private")).toBe(true);
		expect(isValidIgnoredFolderName(" _secret ")).toBe(true);
		expect(isValidIgnoredFolderName("nested/folder")).toBe(false);
		expect(isValidIgnoredFolderName("nested\\folder")).toBe(false);
		expect(isValidIgnoredFolderName("   ")).toBe(false);
	});
});
