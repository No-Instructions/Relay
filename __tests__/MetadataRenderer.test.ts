const getFrontMatterInfo = jest.fn();
const parseYaml = jest.fn();

jest.mock(
	"obsidian",
	() => ({
		MarkdownView: class MarkdownView {},
		getFrontMatterInfo: (...args: any[]) => getFrontMatterInfo(...args),
		parseYaml: (...args: any[]) => parseYaml(...args),
	}),
	{ virtual: true },
);

import { MetadataRenderer } from "../src/plugins/MetadataRenderer";

type FakeElement = {
	tagName: string;
	type?: string;
	contentEditable?: string;
	checked?: boolean;
	children: FakeElement[];
	tabIndex?: number;
	listeners: Record<string, Array<(event: any) => void>>;
	appendChild: (child: FakeElement) => void;
	querySelector: (selector: string) => FakeElement | null;
	contains: (target: FakeElement | null | undefined) => boolean;
	focus: () => void;
	addEventListener: (type: string, listener: (event: any) => void) => void;
	removeEventListener: (type: string, listener: (event: any) => void) => void;
	dispatchEvent: (event: any) => void;
};

function createFakeElement(tagName: string, attrs: Partial<FakeElement> = {}): FakeElement {
	const el: FakeElement = {
		tagName,
		children: [],
		listeners: {},
		appendChild(child: FakeElement) {
			this.children.push(child);
		},
		querySelector(selector: string) {
			if (
				selector === 'input[type="checkbox"]' &&
				this.tagName === "INPUT" &&
				this.type === "checkbox"
			) {
				return this;
			}
			for (const child of this.children) {
				const found = child.querySelector(selector);
				if (found) return found;
			}
			return null;
		},
		contains(target: FakeElement | null | undefined) {
			if (!target) return false;
			if (target === this) return true;
			return this.children.some((child) => child.contains(target));
		},
		focus() {
			(globalThis as any).document.activeElement = this;
		},
		addEventListener(type, listener) {
			this.listeners[type] ??= [];
			this.listeners[type].push(listener);
		},
		removeEventListener(type, listener) {
			this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== listener);
		},
		dispatchEvent(event) {
			for (const listener of this.listeners[event.type] ?? []) {
				listener(event);
			}
		},
		...attrs,
	};
	return el;
}

describe("MetadataRenderer", () => {
	beforeEach(() => {
		getFrontMatterInfo.mockReset();
		parseYaml.mockReset();
		(globalThis as any).document = { activeElement: null };
	});

	afterEach(() => {
		delete (globalThis as any).document;
	});

	it("re-renders rows when focus is on a checkbox control", () => {
		getFrontMatterInfo.mockReturnValue({ frontmatter: "in stock: false\n" });
		parseYaml.mockReturnValue({ "in stock": false });

		const checkbox = createFakeElement("INPUT", {
			type: "checkbox",
			checked: true,
		});

		const row = createFakeElement("DIV");
		row.appendChild(checkbox);

		const prop = {
			entry: { key: "in stock", value: false },
			containerEl: row,
			renderProperty: jest.fn(() => {
				// Simulate the stale-DOM bug: entry is false, checkbox stays checked.
				checkbox.checked = true;
			}),
		};

		const metadataEditor = {
			contentEl: createFakeElement("DIV"),
			rendered: [prop],
			synchronize: jest.fn(),
		};
		metadataEditor.contentEl.appendChild(row);

		const view = {
			file: { path: "private/groceries/butter.md" },
			metadataEditor,
		} as any;
		const renderer = new MetadataRenderer(view);

		checkbox.focus();

		renderer.render({ localText: "---\nin stock: false\n---\n" } as any, "source");

		expect(prop.renderProperty).toHaveBeenCalledTimes(1);
		expect(metadataEditor.synchronize).toHaveBeenCalledTimes(1);
	});

	it("skips re-render for focused text input rows", () => {
		getFrontMatterInfo.mockReturnValue({ frontmatter: "title: Toast\n" });
		parseYaml.mockReturnValue({ title: "Toast" });

		const row = createFakeElement("DIV");
		const input = createFakeElement("INPUT", { type: "text" });
		row.appendChild(input);

		const metadataEditor = {
			contentEl: createFakeElement("DIV"),
			rendered: [],
			synchronize: jest.fn(),
		};
		metadataEditor.contentEl.appendChild(row);

		const prop = {
			entry: { key: "title", value: "Toast" },
			containerEl: row,
			renderProperty: jest.fn(),
		};
		metadataEditor.rendered = [prop];

		const view = {
			file: { path: "private/groceries/butter.md" },
			metadataEditor,
		} as any;
		const renderer = new MetadataRenderer(view);

		input.focus();

		renderer.render({ localText: "---\ntitle: Toast\n---\n" } as any, "source");

		expect(metadataEditor.synchronize).toHaveBeenCalledTimes(1);
		expect(prop.renderProperty).not.toHaveBeenCalled();
	});

	it("re-renders a text input row after blur", async () => {
		getFrontMatterInfo.mockReturnValue({ frontmatter: "title: Toast\n" });
		parseYaml.mockReturnValue({ title: "Toast" });

		const row = createFakeElement("DIV");
		const input = createFakeElement("INPUT", { type: "text" });
		row.appendChild(input);

		const metadataEditor = {
			contentEl: createFakeElement("DIV"),
			rendered: [],
			synchronize: jest.fn(),
		};
		metadataEditor.contentEl.appendChild(row);

		const prop = {
			entry: { key: "title", value: "Toast" },
			containerEl: row,
			renderProperty: jest.fn(),
		};
		metadataEditor.rendered = [prop];

		const view = {
			file: { path: "private/groceries/butter.md" },
			metadataEditor,
		} as any;
		const renderer = new MetadataRenderer(view);

		input.focus();
		renderer.render({ localText: "---\ntitle: Toast\n---\n" } as any, "source");
		expect(prop.renderProperty).not.toHaveBeenCalled();

		(globalThis as any).document.activeElement = null;
		metadataEditor.contentEl.dispatchEvent({ type: "focusout", target: input });
		await Promise.resolve();

		expect(prop.renderProperty).toHaveBeenCalledTimes(1);
	});

	it("re-renders rows when focus is on a non-input container", () => {
		getFrontMatterInfo.mockReturnValue({ frontmatter: "title: Toast\n" });
		parseYaml.mockReturnValue({ title: "Toast" });

		const row = createFakeElement("DIV");

		const metadataEditor = {
			contentEl: createFakeElement("DIV"),
			rendered: [],
			synchronize: jest.fn(),
		};
		metadataEditor.contentEl.appendChild(row);

		const prop = {
			entry: { key: "title", value: "Toast" },
			containerEl: row,
			renderProperty: jest.fn(),
		};
		metadataEditor.rendered = [prop];

		const view = {
			file: { path: "private/groceries/butter.md" },
			metadataEditor,
		} as any;
		const renderer = new MetadataRenderer(view);

		row.tabIndex = 0;
		row.focus();

		renderer.render({ localText: "---\ntitle: Toast\n---\n" } as any, "source");

		expect(metadataEditor.synchronize).toHaveBeenCalledTimes(1);
		expect(prop.renderProperty).toHaveBeenCalledTimes(1);
	});
});
