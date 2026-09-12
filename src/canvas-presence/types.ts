/** Full canvas-space snapshots carried in the Yjs awareness `canvas` field. */
import type { CanvasBBox, CanvasPoint, CanvasSide } from "../CanvasView";

export const CANVAS_PRESENCE_FIELD = "canvas";
export const CANVAS_PRESENCE_VERSION = 1;

export interface CanvasPresenceViewport extends CanvasBBox {
	/** Screen pixels per canvas unit. */
	scale: number;
}
export interface CanvasPresenceGeometry extends CanvasPoint {
	width: number;
	height: number;
}
export interface CanvasPresencePointer extends CanvasPoint { shape: string }
export type CanvasPresenceTarget = { kind: "node" | "edge"; id: string };
export type CanvasPresenceEdgeEnd =
	| { kind: "node"; node: string; side: CanvasSide }
	| ({ kind: "point" } & CanvasPoint);
export interface CanvasPresenceEdge {
	id?: string;
	from: CanvasPresenceEdgeEnd;
	to: CanvasPresenceEdgeEnd;
}
/** A fresh id identifies each gesture; offsets and geometry share one sample. */
export type CanvasPresenceInteraction =
	| { id: string; kind: "transform"; nodes: Record<string, CanvasPresenceGeometry>;
		anchor: { node: string; dx: number; dy: number } | null }
	| { id: string; kind: "connect"; edge: CanvasPresenceEdge;
		anchor: { end: "from" | "to"; dx: number; dy: number } | null }
	| { id: string; kind: "edit"; node: string };

export interface CanvasPresenceState {
	version: typeof CANVAS_PRESENCE_VERSION;
	pointer: CanvasPresencePointer | null;
	viewport: CanvasPresenceViewport | null;
	selection: { nodes: string[]; edges: string[] };
	focus: CanvasPresenceTarget | null;
	interaction: CanvasPresenceInteraction | null;
}
export interface CanvasPresenceUser {
	id?: string;
	name?: string;
	color?: string;
	colorLight?: string;
}

export function emptyCanvasPresence(): CanvasPresenceState {
	return { version: CANVAS_PRESENCE_VERSION, pointer: null, viewport: null,
		selection: { nodes: [], edges: [] }, focus: null, interaction: null };
}

/** Permission filtering applies to every editing preview through one field. */
export function readOnlyCanvasPresence(state: CanvasPresenceState): CanvasPresenceState {
	return { ...state, interaction: null };
}

export function isCanvasSide(value: unknown): value is CanvasSide {
	return typeof value === "string" && ["top", "right", "bottom", "left"].includes(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function isId(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
export function readCanvasPoint(value: unknown): CanvasPoint | null {
	return isRecord(value) && finite(value.x) && finite(value.y) ? { x: value.x, y: value.y } : null;
}
function readViewport(value: unknown): CanvasPresenceViewport | null {
	if (!isRecord(value)) return null;
	const { minX, minY, maxX, maxY, scale } = value;
	return finite(minX) && finite(minY) && finite(maxX) && finite(maxY) && finite(scale)
		&& maxX > minX && maxY > minY && scale > 0
		? { minX, minY, maxX, maxY, scale } : null;
}
function readIds(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.filter(isId))].sort() : [];
}
function readTarget(value: unknown): CanvasPresenceTarget | null {
	return isRecord(value) && (value.kind === "node" || value.kind === "edge") && isId(value.id)
		? { kind: value.kind, id: value.id } : null;
}
function readEdgeEnd(value: unknown): CanvasPresenceEdgeEnd | null {
	if (!isRecord(value)) return null;
	if (value.kind === "node" && isId(value.node) && isCanvasSide(value.side)) {
		return { kind: "node", node: value.node, side: value.side };
	}
	const point = value.kind === "point" ? readCanvasPoint(value) : null;
	return point ? { kind: "point", ...point } : null;
}
function readEdge(value: unknown): CanvasPresenceEdge | null {
	if (!isRecord(value)) return null;
	const from = readEdgeEnd(value.from);
	const to = readEdgeEnd(value.to);
	if (!from || !to || (from.kind === "point" && to.kind === "point")) return null;
	return isId(value.id) ? { id: value.id, from, to } : { from, to };
}
function readGeometry(value: unknown): CanvasPresenceGeometry | null {
	const point = readCanvasPoint(value);
	if (!point || !isRecord(value) || !finite(value.width) || !finite(value.height)
		|| value.width <= 0 || value.height <= 0) return null;
	return { ...point, width: value.width, height: value.height };
}
function readInteraction(value: unknown): CanvasPresenceInteraction | null {
	if (!isRecord(value) || !isId(value.id)) return null;
	const id = value.id;
	const rawAnchor = isRecord(value.anchor) ? value.anchor : {};
	const offset = finite(rawAnchor.dx) && finite(rawAnchor.dy)
		? { dx: rawAnchor.dx, dy: rawAnchor.dy } : null;
	switch (value.kind) {
		case "transform": {
			if (!isRecord(value.nodes)) return null;
			const entries: [string, CanvasPresenceGeometry][] = [];
			for (const [node, raw] of Object.entries(value.nodes)) {
				const geometry = readGeometry(raw);
				if (isId(node) && geometry) entries.push([node, geometry]);
			}
			if (!entries.length) return null;
			const nodes = Object.fromEntries(entries);
			const anchor = offset && isId(rawAnchor.node) && Object.prototype.hasOwnProperty.call(nodes, rawAnchor.node)
				? { node: rawAnchor.node, ...offset } : null;
			return { id, kind: "transform", nodes, anchor };
		}
		case "connect": {
			const edge = readEdge(value.edge);
			if (!edge) return null;
			let anchor: Extract<CanvasPresenceInteraction, { kind: "connect" }>["anchor"] = null;
			if (offset && (rawAnchor.end === "from" || rawAnchor.end === "to")
				&& edge[rawAnchor.end].kind === "point") anchor = { end: rawAnchor.end, ...offset };
			return { id, kind: "connect", edge, anchor };
		}
		case "edit": return isId(value.node) ? { id, kind: "edit", node: value.node } : null;
		default: return null;
	}
}

/**
 * Unknown versions withdraw presence. Within a supported version, additive
 * fields are ignored and malformed or unknown features clear that feature.
 * Snapshots replace all prior state; omitted nullable fields mean null.
 */
export function readCanvasPresence(awarenessState: unknown): CanvasPresenceState | null {
	if (!isRecord(awarenessState)) return null;
	const field = awarenessState[CANVAS_PRESENCE_FIELD];
	if (!isRecord(field) || field.version !== CANVAS_PRESENCE_VERSION) return null;
	const pointer = readCanvasPoint(field.pointer);
	const selection = isRecord(field.selection) ? field.selection : {};
	return {
		version: CANVAS_PRESENCE_VERSION,
		pointer: pointer ? { ...pointer, shape: isRecord(field.pointer) && isCursorKeyword(field.pointer.shape)
			? field.pointer.shape : DEFAULT_CURSOR_SHAPE } : null,
		viewport: readViewport(field.viewport),
		selection: { nodes: readIds(selection.nodes), edges: readIds(selection.edges) },
		focus: readTarget(field.focus),
		interaction: readInteraction(field.interaction),
	};
}
export function readCanvasPresenceUser(awarenessState: unknown): CanvasPresenceUser | undefined {
	if (!isRecord(awarenessState) || !isRecord(awarenessState.user)) return undefined;
	const user = awarenessState.user;
	return {
		id: typeof user.id === "string" ? user.id : undefined,
		name: typeof user.name === "string" ? user.name : undefined,
		color: typeof user.color === "string" ? user.color : undefined,
		colorLight: typeof user.colorLight === "string" ? user.colorLight : undefined,
	};
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
