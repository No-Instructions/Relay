import { areCanvasDataEqual } from "../../src/CanvasData";

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
});
