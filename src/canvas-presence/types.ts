/**
 * The transient, per-viewer state a canvas peer shares through yjs
 * awareness next to its user profile: where the viewer is looking and
 * pointing, which items it has active and how, and a connection it is
 * drawing. None of it is canvas content; it never reaches the canvas file
 * or either CRDT.
 */

import type { CanvasBBox, CanvasPoint, CanvasSide } from "../CanvasView";

/**
 * "attached": the view is open; viewport and item states publish at a low
 * rate and no cursor is published.
 * "active": the pointer is over the canvas; the cursor, and anything that
 * follows the pointer, publish at the cursor rate.
 */
export type CanvasPresenceMode = "attached" | "active";

export interface CanvasPresenceViewport extends CanvasBBox {
	/** The zoom exponent; the scale is 2 ** zoom. */
	zoom: number;
}

/** A node side, or a floating point that follows the pointer. */
export type CanvasPresenceEdgeEnd = { node: string; side: CanvasSide } | CanvasPoint;

/**
 * A connection being drawn. An existing edge whose end is being moved
 * carries its id, so a peer that has the edge moves its own copy; a new
 * connection has an id no peer knows yet.
 */
export interface CanvasPresenceEdge {
	id?: string;
	from: CanvasPresenceEdgeEnd;
	to: CanvasPresenceEdgeEnd;
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

export interface CanvasPresenceGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A node or edge the viewer has active: Obsidian's state classes on it, and live geometry while it is being dragged. */
export interface CanvasPresenceItem {
	classes: StateClass[];
	geometry?: CanvasPresenceGeometry;
}

/**
 * Where the pointer is relative to the item it is attached to: a node
 * being dragged or resized, or the floating end of a connection being
 * drawn. Sampled together with that item's geometry, so a peer rendering
 * the item's trail renders the cursor from the same sample and the two can
 * never drift apart.
 */
export type CanvasPresenceAnchor =
	| { node: string; dx: number; dy: number }
	| { edge: true; dx: number; dy: number };

export interface CanvasPresenceState {
	mode: CanvasPresenceMode;
	viewport: CanvasPresenceViewport | null;
	cursor: CanvasPoint | null;
	/** The CSS cursor keyword under the pointer while the mode is active. */
	shape: string;
	/** The pointer's position in the space of the item it is attached to, or null when free. */
	anchor: CanvasPresenceAnchor | null;
	/** Active nodes and edges by id. */
	items: Record<string, CanvasPresenceItem>;
	edge: CanvasPresenceEdge | null;
}

/** The awareness field the canvas state lives under. */
export const CANVAS_PRESENCE_FIELD = "canvas";

/** The user profile fields the awareness state announces next to the canvas field. */
export interface CanvasPresenceUser {
	id?: string;
	name?: string;
	color?: string;
	colorLight?: string;
}

export const DEFAULT_CURSOR_SHAPE = "default";

/** Every CSS cursor keyword; anything else a peer sends renders as the default. */
const CURSOR_KEYWORDS: ReadonlySet<string> = new Set([
	"auto", "default", "none", "context-menu", "help", "pointer", "progress",
	"wait", "cell", "crosshair", "text", "vertical-text", "alias", "copy",
	"move", "no-drop", "not-allowed", "grab", "grabbing", "all-scroll",
	"col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize",
	"ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize",
	"ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out",
]);

export function isCursorKeyword(value: unknown): value is string {
	return typeof value === "string" && CURSOR_KEYWORDS.has(value);
}

export function emptyCanvasPresence(): CanvasPresenceState {
	return {
		mode: "attached",
		viewport: null,
		cursor: null,
		shape: DEFAULT_CURSOR_SHAPE,
		anchor: null,
		items: {},
		edge: null,
	};
}

const SIDES: ReadonlySet<string> = new Set(["top", "right", "bottom", "left"]);

export function isCanvasSide(value: unknown): value is CanvasSide {
	return typeof value === "string" && SIDES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function readCanvasPoint(value: unknown): CanvasPoint | null {
	if (!isRecord(value)) return null;
	if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
	return { x: value.x, y: value.y };
}

function readViewport(value: unknown): CanvasPresenceViewport | null {
	if (!isRecord(value)) return null;
	const { minX, minY, maxX, maxY, zoom } = value;
	if (
		!isFiniteNumber(minX) ||
		!isFiniteNumber(minY) ||
		!isFiniteNumber(maxX) ||
		!isFiniteNumber(maxY) ||
		!isFiniteNumber(zoom)
	) {
		return null;
	}
	return { minX, minY, maxX, maxY, zoom };
}

function readEdgeEnd(value: unknown): CanvasPresenceEdgeEnd | null {
	if (!isRecord(value)) return null;
	if (typeof value.node === "string" && isCanvasSide(value.side)) {
		return { node: value.node, side: value.side };
	}
	return readCanvasPoint(value);
}

function readEdge(value: unknown): CanvasPresenceEdge | null {
	if (!isRecord(value)) return null;
	const from = readEdgeEnd(value.from);
	const to = readEdgeEnd(value.to);
	if (!from || !to) return null;
	return typeof value.id === "string" ? { id: value.id, from, to } : { from, to };
}

function isStateClass(value: unknown): value is StateClass {
	return typeof value === "string" && (STATE_CLASSES as readonly string[]).includes(value);
}

function readGeometry(value: unknown): CanvasPresenceGeometry | undefined {
	if (!isRecord(value)) return undefined;
	const { x, y, width, height } = value;
	if (
		!isFiniteNumber(x) ||
		!isFiniteNumber(y) ||
		!isFiniteNumber(width) ||
		!isFiniteNumber(height)
	) {
		return undefined;
	}
	return { x, y, width, height };
}

function readAnchor(value: unknown): CanvasPresenceAnchor | null {
	if (!isRecord(value)) return null;
	if (!isFiniteNumber(value.dx) || !isFiniteNumber(value.dy)) return null;
	if (typeof value.node === "string") {
		return { node: value.node, dx: value.dx, dy: value.dy };
	}
	if (value.edge === true) {
		return { edge: true, dx: value.dx, dy: value.dy };
	}
	return null;
}

function readItems(value: unknown): Record<string, CanvasPresenceItem> {
	const items: Record<string, CanvasPresenceItem> = {};
	if (!isRecord(value)) return items;
	for (const [id, raw] of Object.entries(value)) {
		if (!isRecord(raw) || !Array.isArray(raw.classes)) continue;
		const classes = raw.classes.filter(isStateClass);
		const geometry = readGeometry(raw.geometry);
		if (classes.length === 0 && !geometry) continue;
		items[id] = geometry ? { classes, geometry } : { classes };
	}
	return items;
}

/**
 * Read a peer's canvas presence from its full awareness state. Absent or
 * malformed sub-fields degrade to their empty values so a peer on another
 * plugin version still shows what it can; only a missing field, or one
 * with no recognizable mode, reads as no presence.
 */
export function readCanvasPresence(
	awarenessState: unknown,
): CanvasPresenceState | null {
	if (!isRecord(awarenessState)) return null;
	const field = awarenessState[CANVAS_PRESENCE_FIELD];
	if (!isRecord(field)) return null;
	const mode: CanvasPresenceMode = field.mode === "active" ? "active" : "attached";
	const cursor = mode === "active" ? readCanvasPoint(field.cursor) : null;
	return {
		mode: cursor ? "active" : "attached",
		viewport: readViewport(field.viewport),
		cursor,
		shape: cursor && isCursorKeyword(field.shape) ? field.shape : DEFAULT_CURSOR_SHAPE,
		anchor: cursor ? readAnchor(field.anchor) : null,
		items: readItems(field.items),
		edge: readEdge(field.edge),
	};
}

export function readCanvasPresenceUser(
	awarenessState: unknown,
): CanvasPresenceUser | undefined {
	if (!isRecord(awarenessState) || !isRecord(awarenessState.user)) {
		return undefined;
	}
	const user = awarenessState.user;
	return {
		id: typeof user.id === "string" ? user.id : undefined,
		name: typeof user.name === "string" ? user.name : undefined,
		color: typeof user.color === "string" ? user.color : undefined,
		colorLight: typeof user.colorLight === "string" ? user.colorLight : undefined,
	};
}
