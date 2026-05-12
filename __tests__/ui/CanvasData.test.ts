jest.mock(
	"obsidian",
	() => ({
		apiVersion: "1.0.0",
		requestUrl: jest.fn(),
	}),
	{ virtual: true },
);

jest.mock("../../src/HasProvider", () => {
	const Y = require("yjs");
	return {
		HasProvider: class HasProvider {
			_ydoc: any = null;
			get ydoc() {
				if (!this._ydoc) this._ydoc = new Y.Doc();
				return this._ydoc;
			}
			setLoggers() {}
			subscribe() {
				return () => {};
			}
			destroy() {}
		},
	};
});

import { areCanvasDataEqual } from "../../src/CanvasData";
import { Canvas } from "../../src/Canvas";
import * as Y from "yjs";

describe("CanvasData", () => {
	test("treats reordered nodes and object keys as equal", () => {
		const left = {
			nodes: [
				{ id: "a", type: "group", x: 0, y: 0, width: 100, height: 100 },
				{ id: "b", type: "file", file: "note.md", x: 10, y: 20, width: 80, height: 60 },
			],
			edges: [{ id: "e", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" }],
		};
		const right = {
			nodes: [
				{ width: 80, file: "note.md", y: 20, type: "file", id: "b", height: 60, x: 10 },
				{ height: 100, width: 100, y: 0, id: "a", x: 0, type: "group" },
			],
			edges: [{ toSide: "left", fromSide: "right", toNode: "b", fromNode: "a", id: "e" }],
		};

		expect(areCanvasDataEqual(left, right)).toBe(true);
	});

	test("detects real node changes", () => {
		const left = {
			nodes: [{ id: "a", type: "group", x: 0, y: 0, width: 100, height: 100 }],
			edges: [],
		};
		const right = {
			nodes: [{ id: "a", type: "group", x: 1, y: 0, width: 100, height: 100 }],
			edges: [],
		};

		expect(areCanvasDataEqual(left, right)).toBe(false);
	});

	test("repairs stale text-node CRDT content when applying canvas data", async () => {
		const canvas = Object.create(Canvas.prototype) as Canvas & { _ydoc: Y.Doc };
		canvas._ydoc = new Y.Doc();
		canvas.ynodes.set("a", {
			id: "a",
			type: "text",
			text: "HELLO",
			x: 0,
			y: 0,
			width: 100,
			height: 100,
		});
		canvas.ydoc.getText("a").insert(0, "HELLOHELLO");

		expect(Canvas.exportCanvasData(canvas.ydoc).nodes[0].text).toBe(
			"HELLOHELLO",
		);
		expect(Canvas.exportCanvasMapData(canvas.ydoc).nodes[0].text).toBe(
			"HELLO",
		);

		await canvas.applyData({
			nodes: [
				{
					id: "a",
					type: "text",
					text: "HELLO",
					x: 0,
					y: 0,
					width: 100,
					height: 100,
				},
			],
			edges: [],
		});

		expect(Canvas.exportCanvasData(canvas.ydoc)).toEqual({
			nodes: [
				{
					id: "a",
					type: "text",
					text: "HELLO",
					x: 0,
					y: 0,
					width: 100,
					height: 100,
				},
			],
			edges: [],
		});
	});
});
