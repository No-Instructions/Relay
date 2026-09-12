/** Obsidian sampling/rendering adapter. Native CSS state never crosses the wire. */
import type { CanvasBBox, CanvasPoint, CanvasSide } from "../CanvasView";
import {
	DEFAULT_CURSOR_SHAPE,
	emptyCanvasPresence,
	type CanvasPresenceState,
	type CanvasPresenceEdgeEnd,
	type CanvasPresenceInteraction,
} from "./types";

export type NativeCanvasPresenceMode = "attached" | "active";

export interface NativeCanvasPresenceViewport extends CanvasBBox {
	/** The zoom exponent; the scale is 2 ** zoom. */
	zoom: number;
}

/** A node side, or a floating point that follows the pointer. */
export type NativeCanvasPresenceEdgeEnd = { node: string; side: CanvasSide } | CanvasPoint;

/**
 * A connection being drawn. An existing edge whose end is being moved
 * carries its id, so a peer that has the edge moves its own copy; a new
 * connection has an id no peer knows yet.
 */
export interface NativeCanvasPresenceEdge {
	id?: string;
	from: NativeCanvasPresenceEdgeEnd;
	to: NativeCanvasPresenceEdgeEnd;
}

/**
 * The state classes Obsidian puts on a node or edge element that peers
 * mirror. Obsidian expresses every active state this way, so this list is
 * the whole vocabulary: a selected card or edge, the card whose editor is
 * open, and a card being dragged or resized.
 */
export const STATE_CLASSES = [
	"is-focused",
	"is-selected",
	"is-editing",
	"is-dragging",
] as const;
export type StateClass = (typeof STATE_CLASSES)[number];

export interface NativeCanvasPresenceGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A node or edge the viewer has active: Obsidian's state classes on it, and live geometry while it is being dragged. */
export interface NativeCanvasPresenceItem {
	kind: "node" | "edge";
	classes: StateClass[];
	geometry?: NativeCanvasPresenceGeometry;
}

/**
 * Where the pointer is relative to the item it is attached to: a node
 * being dragged or resized, or the floating end of a connection being
 * drawn. Sampled together with that item's geometry, so a peer rendering
 * the item's trail renders the cursor from the same sample and the two can
 * never drift apart.
 */
export type NativeCanvasPresenceAnchor =
	| { node: string; dx: number; dy: number }
	| { edge: true; dx: number; dy: number };

export interface NativeCanvasPresenceState {
	interactionId: string | null;
	mode: NativeCanvasPresenceMode;
	viewport: NativeCanvasPresenceViewport | null;
	cursor: CanvasPoint | null;
	/** The CSS cursor keyword under the pointer while the mode is active. */
	shape: string;
	/** The pointer's position in the space of the item it is attached to, or null when free. */
	anchor: NativeCanvasPresenceAnchor | null;
	/** Active nodes and edges by id. */
	items: Record<string, NativeCanvasPresenceItem>;
	edge: NativeCanvasPresenceEdge | null;
}

export function emptyNativeCanvasPresence(): NativeCanvasPresenceState {
	return {
		interactionId: null,
		mode: "attached",
		viewport: null,
		cursor: null,
		shape: DEFAULT_CURSOR_SHAPE,
		anchor: null,
		items: {},
		edge: null,
	};
}

/** Readers share where they look and select, without moving or editing shared items. */
export function readOnlyNativeCanvasPresence(state: NativeCanvasPresenceState): NativeCanvasPresenceState {
	const items: Record<string, NativeCanvasPresenceItem> = {};
	for (const [id, item] of Object.entries(state.items)) {
		const classes = item.classes.filter((name) => name === "is-focused" || name === "is-selected");
		if (classes.length > 0) items[id] = { kind: item.kind, classes };
	}
	return { ...state, interactionId: null, anchor: null, items, edge: null };
}

/** Identifies the active gesture's kind and targets, independently of geometry. */
export function interactionKey(state: NativeCanvasPresenceState): string | null {
	if (state.edge) return JSON.stringify(["connect", state.edge.id]);
	const moving = Object.keys(state.items).filter(id => state.items[id].kind === "node" && state.items[id].geometry).sort();
	if (moving.length) return JSON.stringify(["transform", ...moving]);
	const editing = Object.keys(state.items).find(id => state.items[id].kind === "node" && state.items[id].classes.includes("is-editing"));
	return editing ? JSON.stringify(["edit", editing]) : null;
}

export function toCanvasPresence(state: NativeCanvasPresenceState): CanvasPresenceState {
	const result = emptyCanvasPresence();
	if (state.cursor) result.pointer = { ...state.cursor, shape: state.shape };
	if (state.viewport) {
		const { zoom, ...bounds } = state.viewport;
		result.viewport = { ...bounds, scale: 2 ** zoom };
	}
	const nodes: Extract<CanvasPresenceInteraction, { kind: "transform" }>["nodes"] = Object.create(null);
	let editing: string | null = null;
	for (const [id, item] of Object.entries(state.items)) {
		if (item.classes.includes("is-selected")) result.selection[item.kind === "node" ? "nodes" : "edges"].push(id);
		if (item.classes.includes("is-focused")) result.focus = { kind: item.kind, id };
		if (item.kind === "node" && item.geometry) nodes[id] = { ...item.geometry };
		if (item.kind === "node" && item.classes.includes("is-editing")) editing = id;
	}
	const id = state.interactionId;
	if (!id) return result;
	if (state.edge) {
		const end = "node" in state.edge.to ? "from" : "to";
		const anchor: Extract<CanvasPresenceInteraction, { kind: "connect" }>["anchor"] = state.anchor && "edge" in state.anchor && !("node" in state.edge[end])
			? { end, dx: state.anchor.dx, dy: state.anchor.dy } : null;
		result.interaction = { id, kind: "connect", edge: {
			...(state.edge.id ? { id: state.edge.id } : {}),
			from: toEdgeEnd(state.edge.from), to: toEdgeEnd(state.edge.to),
		}, anchor };
	} else if (Object.keys(nodes).length) {
		const anchor = state.anchor && "node" in state.anchor && Object.prototype.hasOwnProperty.call(nodes, state.anchor.node)
			? { ...state.anchor } : null;
		result.interaction = { id, kind: "transform", nodes, anchor };
	} else if (editing) result.interaction = { id, kind: "edit", node: editing };
	return result;
}
function toEdgeEnd(end: NativeCanvasPresenceEdgeEnd): CanvasPresenceEdgeEnd {
	return "node" in end ? { kind: "node", ...end } : { kind: "point", ...end };
}
function fromEdgeEnd(end: CanvasPresenceEdgeEnd): NativeCanvasPresenceEdgeEnd {
	return end.kind === "node" ? { node: end.node, side: end.side } : { x: end.x, y: end.y };
}

export function fromCanvasPresence(state: CanvasPresenceState): NativeCanvasPresenceState {
	const result = emptyNativeCanvasPresence();
	if (state.pointer) {
		result.mode = "active";
		result.cursor = { x: state.pointer.x, y: state.pointer.y };
		result.shape = state.pointer.shape;
	}
	if (state.viewport) {
		const { scale, ...bounds } = state.viewport;
		result.viewport = { ...bounds, zoom: Math.log2(scale) };
	}
	// IDs are document identifiers, not object properties inherited from a prototype.
	result.items = Object.create(null);
	const item = (id: string, kind: "node" | "edge") => result.items[id] ??= { kind, classes: [] };
	for (const id of state.selection.nodes) item(id, "node").classes.push("is-selected");
	for (const id of state.selection.edges) item(id, "edge").classes.push("is-selected");
	if (state.focus) item(state.focus.id, state.focus.kind).classes.push("is-focused");
	const interaction = state.interaction;
	if (!interaction) return result;
	result.interactionId = interaction.id;
	switch (interaction.kind) {
		case "transform":
			for (const [id, geometry] of Object.entries(interaction.nodes)) {
				const target = item(id, "node");
				target.classes.push("is-dragging");
				target.geometry = { ...geometry };
			}
			result.anchor = interaction.anchor ? { ...interaction.anchor } : null;
			break;
		case "connect":
			result.edge = { ...(interaction.edge.id ? { id: interaction.edge.id } : {}),
				from: fromEdgeEnd(interaction.edge.from), to: fromEdgeEnd(interaction.edge.to) };
			result.anchor = interaction.anchor ? { edge: true, dx: interaction.anchor.dx, dy: interaction.anchor.dy } : null;
			break;
		case "edit": item(interaction.node, "node").classes.push("is-editing"); break;
	}
	return result;
}
