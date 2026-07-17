import { diff_match_patch } from "diff-match-patch";
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

function fieldsEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		typeof a === "object" &&
		typeof b === "object" &&
		a !== null &&
		b !== null
	) {
		return areObjectsEqual(a, b);
	}
	return false;
}

/**
 * Character-level three-way text merge: the base→ours diff is applied
 * onto theirs, so concurrent edits to different regions both survive and
 * overlapping edits resolve toward the theirs substrate.
 */
function mergeText(base: string, ours: string, theirs: string): string {
	if (ours === theirs || base === ours) return theirs;
	if (base === theirs) return ours;
	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(base, ours);
	if (diffs.length > 2) {
		dmp.diff_cleanupSemantic(diffs);
	}
	const patches = dmp.patch_make(base, diffs);
	const [result] = dmp.patch_apply(patches, theirs);
	return result;
}

function mergeItem<T extends CanvasItem>(
	base: T | undefined,
	ours: T,
	theirs: T,
): T {
	const keys = new Set([
		...Object.keys(ours),
		...Object.keys(theirs),
		...(base ? Object.keys(base) : []),
	]);
	const out: Record<string, unknown> = {};
	const baseRec = (base ?? {}) as Record<string, unknown>;
	const oursRec = ours as Record<string, unknown>;
	const theirsRec = theirs as Record<string, unknown>;
	for (const key of keys) {
		const b = baseRec[key];
		const o = oursRec[key];
		const t = theirsRec[key];
		if (
			key === "text" &&
			typeof o === "string" &&
			typeof t === "string"
		) {
			out[key] = mergeText(typeof b === "string" ? b : "", o, t);
			continue;
		}
		const oursChanged = !fieldsEqual(b, o);
		const theirsChanged = !fieldsEqual(b, t);
		// A field changed on one side takes that side; changed on both
		// takes theirs — the disk side, the vault's most recent
		// intentional act. The loser is a scalar, never content.
		const value = oursChanged && !theirsChanged ? o : t;
		if (value !== undefined) {
			out[key] = value;
		} else if (!theirsChanged && o !== undefined) {
			out[key] = o;
		}
	}
	return out as T;
}

function mergeItemLists<T extends CanvasItem>(
	base: readonly T[],
	ours: readonly T[],
	theirs: readonly T[],
): T[] {
	const baseById = new Map(base.map((item) => [item.id, item]));
	const oursById = new Map(ours.map((item) => [item.id, item]));
	const theirsById = new Map(theirs.map((item) => [item.id, item]));
	const ids = new Set([
		...oursById.keys(),
		...theirsById.keys(),
		...baseById.keys(),
	]);
	const merged: T[] = [];
	for (const id of ids) {
		const b = baseById.get(id);
		const o = oursById.get(id);
		const t = theirsById.get(id);
		if (o && t) {
			merged.push(mergeItem(b, o, t));
			continue;
		}
		const survivor = o ?? t;
		if (!survivor) continue; // in base only: deleted on both sides
		if (!b) {
			merged.push(survivor); // added on one side
			continue;
		}
		// In base and on one side only: a delete on the other side wins
		// only when the surviving side is unchanged — an edit wins over
		// a delete.
		if (!areObjectsEqual(survivor, b)) {
			merged.push(survivor);
		}
	}
	return merged;
}

/**
 * Three-way canvas merge with a fixed orientation: base is the LCA — the
 * last state disk and localDoc agreed on; ours is the localDoc export,
 * carrying everything that arrived through the CRDT; theirs is the disk
 * file — the vault's most recent intentional act. Identity is the unit
 * of merging, the field is the unit of conflict, and card text merges at
 * character level. Edges whose endpoints did not survive are dropped.
 */
export function mergeCanvasThreeWay(
	base: CanvasData,
	ours: CanvasData,
	theirs: CanvasData,
): CanvasData {
	const nodes = mergeItemLists(
		base.nodes ?? [],
		ours.nodes ?? [],
		theirs.nodes ?? [],
	);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const edges = mergeItemLists(
		base.edges ?? [],
		ours.edges ?? [],
		theirs.edges ?? [],
	).filter(
		(edge) => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode),
	);
	return { nodes, edges };
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
