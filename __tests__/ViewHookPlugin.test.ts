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

	function createFixture() {
		const originalSave = jest.fn();
		const originalSaveFrontmatter = jest.fn(function (this: any) {
			this.text = "next text";
			this.save(this.text, true);
		});
		const hsm = {
			send: jest.fn(),
			computeDiffChanges: jest.fn(() => [
				{ from: 0, to: "old text".length, insert: "next text" },
			]),
		};
		const view = {
			file: { path: "private/groceries/butter.md" },
			previewMode: { renderer: { set: jest.fn() } },
			text: "old text",
			save: originalSave,
			saveFrontmatter: originalSaveFrontmatter,
			getMode: () => "preview",
		} as any;
		const document = {
			path: "/private/groceries/butter.md",
			localText: "old text",
			hsm,
		} as any;
		const plugin = new ViewHookPlugin(view, document);

		return {
			document,
			hsm,
			originalSave,
			originalSaveFrontmatter,
			plugin,
			view,
		};
	}

	it("preserves the persist flag when patching view.save", () => {
		const { originalSave, plugin, view } = createFixture();

		view.save("next text", true);

		expect(originalSave).toHaveBeenCalledTimes(1);
		expect(originalSave).toHaveBeenCalledWith("next text", true);

		plugin.destroy();
	});

	it("routes frontmatter-triggered preview saves through HSM", () => {
		const { hsm, originalSave, originalSaveFrontmatter, plugin, view } = createFixture();

		view.saveFrontmatter({});

		expect(originalSaveFrontmatter).toHaveBeenCalledTimes(1);
		expect(originalSave).toHaveBeenCalledWith("next text", true);
		expect(hsm.computeDiffChanges).toHaveBeenCalledWith("old text", "next text");
		expect(hsm.send).toHaveBeenCalledWith({
			type: "CM6_CHANGE",
			changes: [{ from: 0, to: "old text".length, insert: "next text" }],
			docText: "next text",
			userEvent: "set",
		});

		plugin.destroy();
	});
});
