import { diff_match_patch } from "diff-match-patch";
import { areObjectsEqual } from "./areObjectsEqual";
import { curryLog } from "./debug";
import type { CanvasData, CanvasEdgeData, CanvasNodeData } from "./CanvasView";

const warnMerge = curryLog("[CanvasData]", "warn");

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
 * Character-level three-way text merge: the base→theirs diff is applied
 * onto ours, so concurrent edits to different regions both survive and
 * overlapping edits resolve toward the ours substrate — the localDoc
 * export, carrying the peers' edits.
 */
function mergeText(base: string, ours: string, theirs: string): string {
	if (ours === theirs || base === theirs) return ours;
	if (base === ours) return theirs;
	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(base, theirs);
	if (diffs.length > 2) {
		dmp.diff_cleanupSemantic(diffs);
	}
	const patches = dmp.patch_make(base, diffs);
	const [result, applied] = dmp.patch_apply(patches, ours);
	const failed = applied.filter((ok) => !ok).length;
	if (failed > 0) {
		// Overlapping concurrent edits: part of the base→theirs edit could
		// not be replayed onto ours. The ours substrate survives —
		// but never silently: this function's contract is that edits to
		// different regions both survive, so a dropped patch must be
		// visible in diagnostic logs when it happens.
		warnMerge(
			`character merge dropped ${failed}/${applied.length} patch(es); ` +
				"keeping the peer-side text for the overlapping region",
		);
	}
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
		// takes ours — the localDoc export, carrying what the peers sent
		// through the CRDT. The disk side loses value conflicts; its
		// one-sided edits and additions still survive.
		let value = theirsChanged && !oursChanged ? t : o;
		// One asymmetry is disallowed: a field DELETED on one side never
		// beats a concurrent edit on the other — the same edit-wins-over-
		// delete rule the item level applies. (This covers `text` when the
		// localDoc side dropped it: the string/string merge guard above
		// cannot fire, and without this rule the value rule would take
		// undefined.)
		if (value === undefined && theirsChanged && t !== undefined) {
			value = t;
		}
		if (value !== undefined) {
			out[key] = value;
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
 * file. One-sided changes take the side that made them; a value changed
 * on both sides resolves to ours — the peers' edits — while an edit on
 * either side beats a concurrent delete on the other. Identity is the
 * unit of merging, the field is the unit of conflict, and card text
 * merges at character level. Edges whose endpoints did not survive are
 * dropped.
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

/**
 * Rendered items that match neither the file's local CRDT nor its disk
 * copy: an item counts as the file's own when the file holds an item with
 * the same id and the same content on either side.
 */
function foreignItems<T extends CanvasItem>(
	rendered: readonly T[],
	local: readonly T[],
	disk: readonly T[],
): T[] {
	const localById = new Map(local.map((item) => [item.id, item]));
	const diskById = new Map(disk.map((item) => [item.id, item]));
	return rendered.filter((item) => {
		const own = localById.get(item.id);
		const saved = diskById.get(item.id);
		return !(
			(!!own && areObjectsEqual(item, own)) ||
			(!!saved && areObjectsEqual(item, saved))
		);
	});
}

/**
 * The rendered nodes and edges that cannot be view.file's own, for
 * diagnostics; empty on both when the view's data belongs to the file.
 */
export function foreignViewItems(
	view: CanvasData | null | undefined,
	local: CanvasData | null | undefined,
	disk: CanvasData | null | undefined,
): { nodes: CanvasNodeData[]; edges: CanvasEdgeData[] } {
	return {
		nodes: foreignItems(view?.nodes ?? [], local?.nodes ?? [], disk?.nodes ?? []),
		edges: foreignItems(view?.edges ?? [], local?.edges ?? [], disk?.edges ?? []),
	};
}

/**
 * Whether a canvas view's rendered data can be taken as view.file's own.
 *
 * Obsidian reuses canvas views across file switches, so between the file
 * pointer moving and setViewData landing a view still renders the previous
 * file's content. A rendered node or edge counts as this file's when the
 * file holds an item with the same id and the same content, in its local
 * CRDT or on disk; a non-empty rendered set made entirely of such items
 * cannot be another file's content unless that file is a byte-identical
 * copy, which is harmless to merge. Matching by id alone would not do: a
 * canvas copied from another keeps its ids, so a view still rendering the
 * original would pass against a copy that has since diverged. Edges are
 * held to the same rule as nodes; a copy that gained or changed an edge
 * between the same nodes is another file's content too, and the reconcile
 * keeps view-only edges. A view holding unsaved edits matches neither and
 * waits for the native save. A view with no nodes is evidence only when
 * the disk copy has none either; an empty view over a populated file is a
 * load still in flight.
 */
export function viewDataBelongsToFile(
	view: CanvasData | null | undefined,
	local: CanvasData | null | undefined,
	disk: CanvasData | null | undefined,
): boolean {
	if (!view) return false;
	if ((view.nodes ?? []).length === 0) {
		return (
			!!disk &&
			(disk.nodes ?? []).length === 0 &&
			(disk.edges ?? []).length === 0 &&
			(view.edges ?? []).length === 0
		);
	}
	const foreign = foreignViewItems(view, local, disk);
	return foreign.nodes.length === 0 && foreign.edges.length === 0;
}
