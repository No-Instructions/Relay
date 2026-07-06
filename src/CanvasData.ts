import { areObjectsEqual } from "./areObjectsEqual";
import type { CanvasData } from "./CanvasView";

interface CanvasItem {
	id: string;
}

export function areCanvasDataEqual(
	left: CanvasData | null | undefined,
	right: CanvasData | null | undefined,
): boolean {
	if (!left || !right) return false;
	return (
		areCanvasItemsEqual(left.nodes ?? [], right.nodes ?? []) &&
		areCanvasItemsEqual(left.edges ?? [], right.edges ?? [])
	);
}

function areCanvasItemsEqual<T extends CanvasItem>(
	left: readonly T[],
	right: readonly T[],
): boolean {
	if (left.length !== right.length) return false;

	const rightById = new Map(right.map((item) => [item.id, item]));
	for (const leftItem of left) {
		const rightItem = rightById.get(leftItem.id);
		if (!rightItem || !areObjectsEqual(leftItem, rightItem)) {
			return false;
		}
	}
	return true;
}

/**
 * Merge canvas data exported from the CRDT with the data a view currently
 * renders. CRDT items are authoritative for shared ids; view-only items are
 * kept because they are local edits that have not been pushed yet. Deletes
 * are not inferred here — a view that has never synchronized with the CRDT
 * legitimately lacks items, and treating absence as deletion is what
 * destroys peer content.
 *
 * Returns null when the view already renders the merged result.
 */
export function mergeCanvasViewData(
	crdt: CanvasData,
	view: CanvasData,
): CanvasData | null {
	const merged: CanvasData = {
		nodes: [...crdt.nodes],
		edges: [...crdt.edges],
	};
	const knownNodes = new Set(crdt.nodes.map((node) => node.id));
	const knownEdges = new Set(crdt.edges.map((edge) => edge.id));
	for (const node of view.nodes) {
		if (!knownNodes.has(node.id)) {
			merged.nodes.push(node);
		}
	}
	for (const edge of view.edges) {
		if (!knownEdges.has(edge.id)) {
			merged.edges.push(edge);
		}
	}
	if (merged.nodes.length === 0 && merged.edges.length === 0) return null;
	if (areCanvasDataEqual(merged, view)) return null;
	return merged;
}

export function formatCanvasData(data: CanvasData): string {
	return formatObsidianJson(data) ?? "";
}

function formatObsidianJson(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return formatObsidianJsonLines(value).join("\n");
}

function formatObsidianJsonLines(value: unknown): string[] {
	if (value === undefined) return ["null"];
	if (
		isPrimitiveJsonValue(value) ||
		value === null ||
		Object.prototype.toString.call(value) === "[object Date]"
	) {
		return [JSON.stringify(value)];
	}

	if (Array.isArray(value)) {
		if (value.every(isPrimitiveJsonValue)) {
			return [JSON.stringify(value)];
		}

		const lines = ["["];
		const lastIndex = value.length - 1;
		for (let index = 0; index <= lastIndex; index++) {
			const childLines = formatObsidianJsonLines(value[index]);
			const lastChildLineIndex = childLines.length - 1;
			for (let lineIndex = 0; lineIndex <= lastChildLineIndex; lineIndex++) {
				let line = `\t${childLines[lineIndex]}`;
				if (lineIndex === lastChildLineIndex && index !== lastIndex) {
					line += ",";
				}
				lines.push(line);
			}
		}
		lines.push("]");
		return lines;
	}

	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		let primitiveOnly = true;
		for (const key in record) {
			if (
				Object.prototype.hasOwnProperty.call(record, key) &&
				!isPrimitiveJsonValue(record[key])
			) {
				primitiveOnly = false;
				break;
			}
		}
		if (primitiveOnly) {
			return [JSON.stringify(record)];
		}

		const keys = Object.keys(record).filter((key) => record[key] !== undefined);
		const lines = ["{"];
		const lastIndex = keys.length - 1;
		for (let index = 0; index <= lastIndex; index++) {
			const key = keys[index];
			const childLines = formatObsidianJsonLines(record[key]);
			childLines[0] = `${JSON.stringify(key)}:${childLines[0]}`;
			const lastChildLineIndex = childLines.length - 1;
			for (let lineIndex = 0; lineIndex <= lastChildLineIndex; lineIndex++) {
				let line = `\t${childLines[lineIndex]}`;
				if (lineIndex === lastChildLineIndex && index !== lastIndex) {
					line += ",";
				}
				lines.push(line);
			}
		}
		lines.push("}");
		return lines;
	}

	return [""];
}

function isPrimitiveJsonValue(value: unknown): boolean {
	return typeof value !== "object";
}
