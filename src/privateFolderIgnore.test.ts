import {
	isRelayIgnoreMarkerPath,
	markerOwnerPath,
	normalizeVirtualPath,
	relayIgnoreMarkerPath,
} from "./privateFolderIgnore";

describe(".relayignore path helpers", () => {
	test.each([
		".relayignore",
		"folder/.relayignore",
		"/folder/.relayignore",
		"folder\\.relayignore",
	])("detects marker path %s", (path) => {
		expect(isRelayIgnoreMarkerPath(path)).toBe(true);
	});

	test.each(["relayignore", ".relayignore.md", "folder/.relayignore/note.md"])(
		"does not treat non-marker path %s as marker",
		(path) => {
			expect(isRelayIgnoreMarkerPath(path)).toBe(false);
		},
	);

	test("normalizes virtual paths", () => {
		expect(normalizeVirtualPath("/folder\\child//note.md")).toBe("folder/child/note.md");
	});

	test("builds marker paths and owners", () => {
		expect(relayIgnoreMarkerPath("folder/child")).toBe("folder/child/.relayignore");
		expect(markerOwnerPath("folder/child/.relayignore")).toBe("folder/child");
		expect(markerOwnerPath(".relayignore")).toBe("");
	});
});
