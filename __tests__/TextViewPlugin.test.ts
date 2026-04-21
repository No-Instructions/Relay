const isLive = jest.fn(() => true);

class TextFileView {}
class MarkdownView extends TextFileView {}

jest.mock(
	"obsidian",
	() => ({
		MarkdownView,
		TextFileView,
	}),
	{ virtual: true },
);

jest.mock("../src/LiveViews", () => ({
	isLive,
}));

jest.mock("../src/Document", () => ({
	Document: class Document {},
}));

jest.mock("../src/plugins/ViewHookPlugin", () => ({
	ViewHookPlugin: class ViewHookPlugin {
		initialize() {
			return Promise.resolve();
		}
		destroy() {}
	},
}));

import { Patcher } from "../src/Patcher";
import { TextFileViewPlugin } from "../src/TextViewPlugin";

describe("TextFileViewPlugin", () => {
	afterEach(() => {
		Patcher.destroy();
		isLive.mockReset();
		isLive.mockReturnValue(true);
	});

	function createPlugin() {
		const file = { path: "private/kanban.md" };
		const originalRequestSave = jest.fn();
		const originalSetViewData = jest.fn();
		const observedText = {
			observe: jest.fn(),
			unobserve: jest.fn(),
		};
		const localDoc = {
			getText: jest.fn(() => observedText),
		};
		const hsm = {
			send: jest.fn(),
			computeDiffChanges: jest.fn(() => [
				{ from: 0, to: "old text".length, insert: "new text" },
			]),
		};
		const doc = {
			_tfile: file,
			tfile: file,
			path: "/private/kanban.md",
			guid: "guid-1",
			text: "old text",
			localText: "old text",
			localDoc,
			hsm,
			save: jest.fn(),
		} as any;
		const textView = new TextFileView() as any;
		Object.assign(textView, {
			file,
			getViewType: () => "kanban",
			getViewData: jest.fn(() => "new text"),
			requestSave: originalRequestSave,
			setViewData: originalSetViewData,
		});
		const liveView = {
			view: textView,
			document: doc,
			tracking: true,
			connectionManager: {
				sharedFolders: {
					lookup: jest.fn(),
				},
			},
		} as any;

		const plugin = new TextFileViewPlugin(liveView);

		return {
			plugin,
			doc,
			hsm,
			liveView,
			originalRequestSave,
			originalSetViewData,
		};
	}

	it("routes local requestSave through HSM and then the owning view autosave path", () => {
		const { doc, hsm, liveView, originalRequestSave } = createPlugin();

		liveView.view.requestSave();

		expect(hsm.computeDiffChanges).toHaveBeenCalledTimes(1);
		expect(hsm.computeDiffChanges).toHaveBeenCalledWith("old text", "new text");
		expect(hsm.send).toHaveBeenCalledTimes(1);
		expect(hsm.send).toHaveBeenCalledWith({
			type: "CM6_CHANGE",
			changes: [{ from: 0, to: "old text".length, insert: "new text" }],
			docText: "new text",
			userEvent: "set",
		});
		expect(originalRequestSave).toHaveBeenCalledTimes(1);
		expect(doc.save).not.toHaveBeenCalled();
	});

	it("syncViewToCRDT persists through setViewData followed by requestSave", async () => {
		const { plugin, doc, originalRequestSave, originalSetViewData } = createPlugin();
		doc.localText = "synced text";

		await plugin.syncViewToCRDT();

		expect(originalSetViewData).toHaveBeenCalledTimes(1);
		expect(originalSetViewData).toHaveBeenCalledWith("synced text", false);
		expect(originalRequestSave).toHaveBeenCalledTimes(1);
		expect(doc.hsm.send).not.toHaveBeenCalled();
		expect(doc.save).not.toHaveBeenCalled();
	});
});
