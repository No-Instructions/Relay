jest.mock(
	"obsidian",
	() => ({
		MarkdownView: class MarkdownView {},
		getFrontMatterInfo: () => ({ frontmatter: "" }),
		parseYaml: () => ({}),
	}),
	{ virtual: true },
);

import { Patcher } from "../src/Patcher";
import { ViewHookPlugin } from "../src/plugins/ViewHookPlugin";

describe("ViewHookPlugin", () => {
	afterEach(() => {
		Patcher.destroy();
	});

	it("preserves the persist flag when patching view.save", () => {
		const originalSave = jest.fn();
		const view = {
			file: { path: "private/groceries/butter.md" },
			previewMode: { renderer: { set: jest.fn() } },
			save: originalSave,
			getMode: () => "preview",
		} as any;
		const document = {
			path: "/private/groceries/butter.md",
		} as any;

		const plugin = new ViewHookPlugin(view, document);

		view.save("next text", true);

		expect(originalSave).toHaveBeenCalledTimes(1);
		expect(originalSave).toHaveBeenCalledWith("next text", true);

		plugin.destroy();
	});
});
