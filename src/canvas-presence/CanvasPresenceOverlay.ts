import { getIcon } from "obsidian";
import type { Awareness } from "y-protocols/awareness";
import type {
	CanvasBBox,
	CanvasEdge,
	CanvasNode,
	CanvasEdgeConstructor,
	CanvasEdgeEnd,
	CanvasEdgeEndStyle,
	CanvasNodeGeometry,
	CanvasPoint,
	CanvasSide,
	ObsidianCanvas,
} from "../CanvasView";
import type { TimeProvider } from "../TimeProvider";
import { PointTrack } from "./smoothing";
import {
	DEFAULT_CURSOR_SHAPE,
	readCanvasPresence,
	readCanvasPresenceUser,
	type CanvasPresenceAnchor,
	type CanvasPresenceEdgeEnd,
	type CanvasPresenceGeometry,
	type CanvasPresenceItem,
	type CanvasPresenceState,
	type CanvasPresenceUser,
	type StateClass,
} from "./types";

const DEFAULT_COLOR = "#30bced";
/** A cursor that has not moved for this long fades until it moves again. */
export const CURSOR_STALE_MS = 30_000;
/** How long the fade of a stale cursor takes. */
const CURSOR_FADE_MS = 400;
/** Cursor glyphs are drawn at this size on screen, whatever the zoom. */
const GLYPH_SIZE = 20;
/** Obsidian's icons are drawn on a 24-unit grid with a 2-unit stroke. */
const ICON_GRID = 24;
const LABEL_FONT_PX = 12;
const LABEL_PAD_X = 6;
const LABEL_HEIGHT = 17;
const LABEL_RADIUS = 4;
const COLOR_PROPERTY = "--relay-presence-color";
/** Marks borrowed Obsidian edge groups so they take no pointer input. */
const PRESENCE_EDGE_CLASS = "relay-presence-edge";
/**
 * A peer's copy of an Obsidian state class: `is-focused` on the peer's
 * element becomes `relay-peer-is-focused` on the local one, which the
 * stylesheet gives Obsidian's look for that state in the peer's color.
 */
const PEER_CLASS_PREFIX = "relay-peer-";
/**
 * After a peer's drag ends, the node holds its last live geometry this long
 * for the model to catch up; a cancelled drag never changes the model, so
 * the hold then hands the element back to Obsidian's own render.
 */
const LIVE_GEOMETRY_HOLD_MS = 1500;
/**
 * The glyph for each CSS cursor keyword: an Obsidian icon name, or Lucide
 * path data (ISC licensed) for the hand glyphs Obsidian's icon set lacks.
 * Keywords without a glyph render the default arrow.
 */
const CURSOR_GLYPHS: Record<string, string | string[]> = {
	default: "mouse-pointer-2",
	pointer: "pointer",
	text: "text-cursor",
	"ns-resize": "move-vertical",
	"row-resize": "move-vertical",
	"ew-resize": "move-horizontal",
	"col-resize": "move-horizontal",
	"nwse-resize": "move-diagonal-2",
	"nesw-resize": "move-diagonal",
	move: "move",
	crosshair: "plus",
	"not-allowed": "ban",
	grab: [
		"M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0",
		"M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2",
		"M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8",
		"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
	],
	grabbing: [
		"M18 11.5V9a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v1.4",
		"M14 10V8a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2",
		"M10 9.9V9a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v5",
		"M6 14v0a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0",
		"M18 11v0a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0",
	],
};

/** An icon ready to draw: its outlines as paths on the 24-unit grid. */
interface Glyph {
	paths: Path2D[];
	/** The arrow is filled in the peer's color with a white outline; every other glyph is stroked. */
	filled: boolean;
}

const glyphCache = new Map<string, Glyph | null>();

/** Obsidian's icon for a cursor keyword as paths, or Lucide's hand paths where Obsidian has none. */
function glyphFor(shape: string): Glyph | null {
	const cached = glyphCache.get(shape);
	if (cached !== undefined) return cached;
	const source = CURSOR_GLYPHS[shape];
	let glyph: Glyph | null = null;
	if (Array.isArray(source)) {
		glyph = { paths: source.map((d) => new Path2D(d)), filled: false };
	} else if (typeof source === "string") {
		const svg = getIcon(source);
		const paths: Path2D[] = [];
		if (svg) {
			for (const child of Array.from(svg.children)) {
				const path = svgShapeToPath(child);
				if (path) paths.push(path);
			}
		}
		if (paths.length > 0) glyph = { paths, filled: shape === DEFAULT_CURSOR_SHAPE };
	}
	glyphCache.set(shape, glyph);
	return glyph;
}

/** An SVG shape element as a Path2D, for the primitives Obsidian's icons use. */
function svgShapeToPath(el: Element): Path2D | null {
	const num = (name: string) => Number(el.getAttribute(name) ?? 0);
	switch (el.tagName.toLowerCase()) {
		case "path": {
			const d = el.getAttribute("d");
			return d ? new Path2D(d) : null;
		}
		case "line":
			return new Path2D(`M${num("x1")} ${num("y1")} L${num("x2")} ${num("y2")}`);
		case "polyline":
		case "polygon": {
			const points = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
			if (points.length < 4) return null;
			let d = `M${points[0]} ${points[1]}`;
			for (let i = 2; i + 1 < points.length; i += 2) d += ` L${points[i]} ${points[i + 1]}`;
			return new Path2D(el.tagName.toLowerCase() === "polygon" ? d + " Z" : d);
		}
		case "circle": {
			const path = new Path2D();
			path.arc(num("cx"), num("cy"), num("r"), 0, Math.PI * 2);
			return path;
		}
		case "rect": {
			const path = new Path2D();
			path.rect(num("x"), num("y"), num("width"), num("height"));
			return path;
		}
		default:
			return null;
	}
}

/** What the surface last drew for a peer, for inspection by tests. */
export interface DrawnCursor {
	clientId: number;
	label: string;
	color: string;
	shape: string;
	glyph: boolean;
	visible: boolean;
	/** The cursor's canvas-space position. */
	x: number | null;
	y: number | null;
	/** The cursor's position on the surface, in CSS pixels. */
	sx: number | null;
	sy: number | null;
	alpha: number;
}

/**
 * Obsidian's edge class is only reachable through an instance. Any edge
 * seen anywhere in this session serves every overlay; a canvas that has
 * never held an edge draws no peer connections until one exists.
 */
let edgeConstructor: CanvasEdgeConstructor | null = null;

export function adoptEdgeConstructor(edge: CanvasEdge): void {
	if (!edgeConstructor && typeof edge?.constructor === "function") {
		edgeConstructor = edge.constructor as unknown as CanvasEdgeConstructor;
	}
}

export interface CanvasPresenceOverlayOptions {
	timeProvider: TimeProvider;
	/** The label shown on a peer's cursor. */
	resolveName: (user: CanvasPresenceUser | undefined) => string;
	/** Called when the number of peers with their pointer on the canvas changes. */
	onActivePeers?: (count: number) => void;
}

interface AppliedItem {
	/** The local elements wearing this item's peer classes. */
	els: Element[];
	classes: StateClass[];
	/** The peer's in-flight geometry applied to the local node element. */
	live: Live | null;
}

/** Live node geometry with the pointer's offset from its origin, sampled together. */
interface GhostValue {
	x: number;
	y: number;
	width: number;
	height: number;
	dx: number;
	dy: number;
}

/** A floating connection end with the pointer's offset from it, sampled together. */
interface FloatingValue {
	x: number;
	y: number;
	dx: number;
	dy: number;
}

/**
 * A node the peer is dragging or resizing, shown where the peer has it by
 * writing the live geometry onto the local node element the way Obsidian's
 * own render does. Nothing in the model changes; when the drag ends the
 * element holds until the model catches up, then Obsidian renders it.
 */
interface Live {
	nodeId: string;
	el: HTMLElement;
	track: PointTrack<GhostValue>;
	/** Set once the peer's drag has ended and the element is waiting for the model. */
	holdTimer: number | null;
}

interface Peer {
	userId: string | undefined;
	shape: string;
	/** Where the cursor is drawn, in canvas space; null while hidden. */
	cursorPoint: CanvasPoint | null;
	/** When the cursor went stale and began to fade; null while it moves. */
	staleAt: number | null;
	/** The cursor's timestamped trail; null while hidden. */
	cursorTrack: PointTrack | null;
	/**
	 * While the peer's pointer is attached to an item, the cursor is drawn
	 * from that item's trail instead of its own, so the two move as one.
	 */
	anchor: CanvasPresenceAnchor | null;
	/** The floating end of a connection being drawn, with the pointer offset. */
	floatingTrack: PointTrack<FloatingValue> | null;
	staleTimer: number | null;
	/** For a new connection: Obsidian's own edge in the peer's color, never in the canvas's edge map. */
	edge: CanvasEdge | null;
	/** For an existing edge the peer is re-ending: the local copy, drawn with the live ends. */
	edgeLive: { edge: CanvasEdge; holdTimer: number | null } | null;
	/** The ends the edge is currently drawn with, live. */
	liveEnds: { from: CanvasEdgeEnd; to: CanvasEdgeEnd } | null;
	floatingEnd: FloatingEnd | null;
	/** The peer's active items applied locally, by node or edge id. */
	items: Map<string, AppliedItem>;
	state: CanvasPresenceState | null;
	color: string;
	name: string;
}

/** The far end of a connection being drawn: a point with no size, as Obsidian's placeholder node. */
class FloatingEnd implements CanvasNodeGeometry {
	readonly id: string;
	x = 0;
	y = 0;
	readonly width = 0;
	readonly height = 0;
	constructor(id: string) {
		this.id = id;
	}
	getBBox(): CanvasBBox {
		return { minX: this.x, minY: this.y, maxX: this.x, maxY: this.y };
	}
}

const OPPOSITE: Record<CanvasSide, CanvasSide> = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left",
};

/**
 * Renders every other viewer of the canvas. Cursors are drawn on one 2D
 * canvas surface laid over the wrapper, redrawn at most once per frame from
 * each peer's trail: however many peers are moving, a frame costs one
 * clear and one pass of glyphs and labels, with no elements for the page
 * to style, layer, or composite. Glyphs are Obsidian's own icons as paths.
 * Every moving thing is played by one animation-frame loop from its trail,
 * so a frame costs one style pass however many peers are moving. A connection is Obsidian's own edge
 * object, created outside the canvas's edge map and selection so it
 * renders with Obsidian's path, arrowhead, and sizing but never enters its
 * data or interaction. Every other active state is Obsidian's own state
 * class, mirrored onto the local element under a peer prefix and styled
 * in the peer's color, and a node the peer is moving is the local node
 * element itself, placed by the same styles Obsidian's render writes.
 */
export class CanvasPresenceOverlay {
	/** The surface every peer cursor is drawn on. */
	readonly surface: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D | null;
	private readonly labelFont: string;
	private surfaceWidth = 0;
	private surfaceHeight = 0;
	private surfaceScale = 0;
	private drawFrame: number | null = null;
	private fadeFrame: number | null = null;
	private activePeers = 0;
	private readonly peers = new Map<number, Peer>();
	private awareness: Awareness | null = null;
	/**
	 * Awareness names the clients each update touched; rendering only those
	 * keeps the cost of a message flat as viewers join, instead of every
	 * message re-rendering every peer.
	 */
	private readonly onAwarenessChange = (change: {
		added: number[];
		updated: number[];
		removed: number[];
	}) => this.renderClients(change);
	private viewportFrame: number | null = null;
	private geometryFrame: number | null = null;
	/** Plays floating connection ends, which Obsidian must redraw each frame; runs only while one is moving. */
	private motionFrame: number | null = null;
	/** The live bounds of every node some peer is moving, by node id, for routing edges. */
	private readonly liveBounds = new Map<string, CanvasBBox>();
	private destroyed = false;

	constructor(
		private canvas: ObsidianCanvas,
		private options: CanvasPresenceOverlayOptions,
	) {
		const doc = canvas.wrapperEl.ownerDocument;
		this.surface = doc.createElement("canvas");
		this.surface.className = "relay-canvas-presence";
		canvas.wrapperEl.appendChild(this.surface);
		this.ctx = this.surface.getContext("2d");
		const win = doc.defaultView;
		const family = win
			? win.getComputedStyle(doc.body).getPropertyValue("--font-interface").trim() ||
				win.getComputedStyle(doc.body).fontFamily
			: "sans-serif";
		this.labelFont = `${LABEL_FONT_PX}px ${family}`;
		const firstEdge = canvas.edges.values().next().value as CanvasEdge | undefined;
		if (firstEdge) adoptEdgeConstructor(firstEdge);
		this.requestDraw();
	}

	/** Follow this awareness instance; null detaches. */
	bind(awareness: Awareness | null): void {
		if (this.awareness === awareness) return;
		this.awareness?.off("change", this.onAwarenessChange);
		this.awareness = awareness;
		this.awareness?.on("change", this.onAwarenessChange);
		this.render();
	}

	/**
	 * The local viewport is animating; redraw every frame until it settles,
	 * since where a canvas-space point lands on the surface moves with it.
	 * Obsidian requests its frame before this hook runs, so each redraw
	 * reads the viewport Obsidian set in the same frame.
	 */
	trackViewport(): void {
		if (this.destroyed || this.viewportFrame !== null) return;
		const win = this.surface.ownerDocument.defaultView;
		if (!win) return;
		const step = () => {
			this.viewportFrame = null;
			if (this.destroyed) return;
			this.draw();
			if (this.canvas.viewportChanged) {
				this.viewportFrame = win.requestAnimationFrame(step);
			}
		};
		this.viewportFrame = win.requestAnimationFrame(step);
	}

	/** Node geometry changed in the model; re-anchor connections and re-apply live geometry. */
	refreshGeometry(): void {
		this.modelChanged();
		if (this.destroyed || this.geometryFrame !== null) return;
		const win = this.surface.ownerDocument.defaultView;
		if (!win) return;
		this.geometryFrame = win.requestAnimationFrame(() => {
			this.geometryFrame = null;
			if (this.destroyed) return;
			const now = this.now();
			for (const peer of this.peers.values()) {
				if (!peer.state) continue;
				this.renderItems(peer, peer.state);
				this.renderEdge(peer, peer.state);
				// Obsidian's render just wrote the model geometry; put the
				// live geometry back on nodes the peer is still moving.
				for (const applied of peer.items.values()) {
					const live = applied.live;
					const value = live?.track.sample(now);
					if (live && value && live.holdTimer === null) this.placeLive(live, value);
				}
				if (peer.edgeLive && peer.edgeLive.holdTimer === null) this.drawLiveEdge(peer);
			}
		});
	}

	/**
	 * Bring the local viewport to where a peer is looking. With several
	 * clients for one user, the one with the pointer on the canvas wins.
	 */
	locateUser(userId: string): boolean {
		let target: CanvasPresenceState | null = null;
		for (const peer of this.peers.values()) {
			if (peer.userId !== userId || !peer.state?.viewport) continue;
			if (!target || peer.state.mode === "active") target = peer.state;
		}
		if (!target?.viewport) return false;
		this.canvas.zoomToBbox(target.viewport);
		return true;
	}

	/** Bring every peer up to date: on bind, and whenever the whole picture may have changed. */
	render(): void {
		if (this.destroyed) return;
		const awareness = this.awareness;
		const seen = new Set<number>();
		if (awareness) {
			awareness.getStates().forEach((raw, clientId) => {
				if (clientId === awareness.clientID) return;
				if (this.renderClient(clientId, raw)) seen.add(clientId);
			});
		}
		for (const [clientId, peer] of Array.from(this.peers)) {
			if (!seen.has(clientId)) this.removePeer(clientId, peer);
		}
		this.afterRender();
	}

	/** Bring only the clients an awareness update touched up to date. */
	private renderClients(change: { added: number[]; updated: number[]; removed: number[] }): void {
		if (this.destroyed) return;
		const awareness = this.awareness;
		if (!awareness) return;
		const states = awareness.getStates();
		for (const clientId of change.removed) {
			const peer = this.peers.get(clientId);
			if (peer) this.removePeer(clientId, peer);
		}
		for (const clientId of change.added.concat(change.updated)) {
			if (clientId === awareness.clientID) continue;
			if (!this.renderClient(clientId, states.get(clientId))) {
				const peer = this.peers.get(clientId);
				if (peer) this.removePeer(clientId, peer);
			}
		}
		this.afterRender();
	}

	/** Redraw the surface, and report how many peers have their pointer on the canvas. */
	private afterRender(): void {
		this.requestDraw();
		let active = 0;
		for (const peer of this.peers.values()) {
			if (peer.state?.mode === "active") active++;
		}
		if (active !== this.activePeers) {
			this.activePeers = active;
			this.options.onActivePeers?.(active);
		}
	}

	/** The number of peers whose pointer is on the canvas. */
	get activePeerCount(): number {
		return this.activePeers;
	}

	/** Render one client's state; false when it carries no presence. */
	private renderClient(clientId: number, raw: unknown): boolean {
		const state = readCanvasPresence(raw);
		if (!state) return false;
		const peer = this.peers.get(clientId) ?? this.createPeer(clientId);
		this.updatePeer(peer, clientId, state, readCanvasPresenceUser(raw));
		return true;
	}

	private createPeer(clientId: number): Peer {
		const peer: Peer = {
			userId: undefined,
			shape: DEFAULT_CURSOR_SHAPE,
			cursorPoint: null,
			staleAt: null,
			cursorTrack: null,
			anchor: null,
			floatingTrack: null,
			staleTimer: null,
			edge: null,
			edgeLive: null,
			liveEnds: null,
			floatingEnd: null,
			items: new Map(),
			state: null,
			// Empty until the first update so the peer's color is always applied,
			// even when it happens to equal the default.
			color: "",
			name: "",
		};
		this.peers.set(clientId, peer);
		return peer;
	}

	private setCursorShape(peer: Peer, shape: string): void {
		peer.shape = shape in CURSOR_GLYPHS ? shape : DEFAULT_CURSOR_SHAPE;
	}

	private updatePeer(
		peer: Peer,
		clientId: number,
		state: CanvasPresenceState,
		user: CanvasPresenceUser | undefined,
	): void {
		peer.userId = user?.id;
		const color = user?.color || DEFAULT_COLOR;
		if (color !== peer.color) {
			peer.color = color;
			for (const item of peer.items.values()) {
				for (const el of item.els) {
					(el as HTMLElement).style.setProperty(COLOR_PROPERTY, color);
				}
			}
		}
		peer.name = this.options.resolveName(user);
		const previous = peer.state;
		peer.state = state;
		this.setCursorShape(peer, state.mode === "active" ? state.shape : DEFAULT_CURSOR_SHAPE);
		this.renderCursor(peer, state, previous);
		this.renderItems(peer, state);
		this.renderEdge(peer, state, clientId);
	}

	private renderCursor(
		peer: Peer,
		state: CanvasPresenceState,
		previous: CanvasPresenceState | null,
	): void {
		const cursor = state.mode === "active" ? state.cursor : null;
		if (!cursor) {
			peer.cursorTrack = null;
			peer.anchor = null;
			peer.cursorPoint = null;
			this.clearStaleTimer(peer);
			return;
		}
		const moved =
			!previous?.cursor ||
			previous.cursor.x !== cursor.x ||
			previous.cursor.y !== cursor.y;
		const anchor = this.resolvableAnchor(peer, state);
		if (anchor) {
			// The item's trail carries the pointer offset; the motion loop
			// places the cursor from it.
			peer.anchor = anchor;
			this.startMotion();
		} else {
			if (peer.anchor || !peer.cursorTrack) {
				// Coming off an item, or just appearing: land where the cursor
				// is now and start a fresh trail from there.
				peer.anchor = null;
				peer.cursorTrack = new PointTrack();
				peer.cursorTrack.push(this.now(), cursor);
				this.placeCursor(peer, cursor);
			} else if (moved) {
				peer.cursorTrack.push(this.now(), cursor);
				this.startMotion();
			}
		}
		if (moved) {
			peer.staleAt = null;
			this.armStaleTimer(peer);
		}
	}

	/** The anchor, provided the item it names is one this overlay is playing. */
	private resolvableAnchor(peer: Peer, state: CanvasPresenceState): CanvasPresenceAnchor | null {
		const anchor = state.anchor;
		if (!anchor) return null;
		if ("node" in anchor) {
			return state.items[anchor.node]?.geometry ? anchor : null;
		}
		return state.edge ? anchor : null;
	}

	private now(): number {
		const win = this.surface.ownerDocument.defaultView;
		return win?.performance?.now() ?? this.options.timeProvider.now();
	}

	/**
	 * Play every trail: cursors, floating connection ends, and moving nodes
	 * are placed each frame where their trails are, a short delay behind
	 * arrival. One loop and one style pass per frame however many peers
	 * there are; it stops on its own once every trail has been played out.
	 */
	private startMotion(): void {
		if (this.destroyed || this.motionFrame !== null) return;
		const win = this.surface.ownerDocument.defaultView;
		if (!win) return;
		const step = () => {
			this.motionFrame = null;
			if (this.destroyed) return;
			const now = this.now();
			let playing = false;
			for (const peer of this.peers.values()) {
				const anchor = peer.anchor;
				if (!anchor && peer.cursorTrack) {
					const point = peer.cursorTrack.sample(now);
					if (point) {
						this.placeCursor(peer, point);
						if (!point.settled) playing = true;
					}
				}
				const floating = peer.floatingTrack?.sample(now);
				if (floating && peer.floatingEnd && (peer.edge || peer.edgeLive)) {
					peer.floatingEnd.x = floating.x;
					peer.floatingEnd.y = floating.y;
					this.drawLiveEdge(peer);
					if (!floating.settled) playing = true;
					if (anchor && "edge" in anchor) {
						this.placeCursor(peer, { x: floating.x + floating.dx, y: floating.y + floating.dy });
					}
				}
				for (const [id, applied] of peer.items) {
					const live = applied.live;
					const value = live?.track.sample(now);
					if (!live || !value) continue;
					this.placeLive(live, value);
					if (!value.settled) playing = true;
					if (anchor && "node" in anchor && anchor.node === id) {
						this.placeCursor(peer, { x: value.x + value.dx, y: value.y + value.dy });
					}
				}
			}
			this.draw();
			if (playing) this.motionFrame = win.requestAnimationFrame(step);
		};
		this.motionFrame = win.requestAnimationFrame(step);
	}

	private placeCursor(peer: Peer, point: CanvasPoint): void {
		if (this.destroyed) return;
		peer.cursorPoint = { x: point.x, y: point.y };
		this.requestDraw();
	}

	private armStaleTimer(peer: Peer): void {
		this.clearStaleTimer(peer);
		peer.staleTimer = this.options.timeProvider.setTimeout(() => {
			peer.staleTimer = null;
			peer.staleAt = this.now();
			this.startFade();
		}, CURSOR_STALE_MS);
	}

	/** Redraw while any stale cursor is still fading. */
	private startFade(): void {
		if (this.destroyed || this.fadeFrame !== null) return;
		const win = this.surface.ownerDocument.defaultView;
		if (!win) return;
		const step = () => {
			this.fadeFrame = null;
			if (this.destroyed) return;
			this.draw();
			const now = this.now();
			for (const peer of this.peers.values()) {
				if (peer.staleAt !== null && now - peer.staleAt < CURSOR_FADE_MS) {
					this.fadeFrame = win.requestAnimationFrame(step);
					return;
				}
			}
		};
		this.fadeFrame = win.requestAnimationFrame(step);
	}

	/** Draw on the next frame, once, however many changes ask for it. */
	private requestDraw(): void {
		if (this.destroyed || this.drawFrame !== null) return;
		const win = this.surface.ownerDocument.defaultView;
		if (!win) return;
		this.drawFrame = win.requestAnimationFrame(() => {
			this.drawFrame = null;
			if (!this.destroyed) this.draw();
		});
	}

	/** Size the surface to the wrapper at the device's pixel density; true when it changed. */
	private sizeSurface(): boolean {
		const rect = this.canvas.canvasRect;
		const win = this.surface.ownerDocument.defaultView;
		if (!rect || !win) return false;
		const width = Math.max(0, Math.round(rect.width));
		const height = Math.max(0, Math.round(rect.height));
		const scale = win.devicePixelRatio || 1;
		if (width === this.surfaceWidth && height === this.surfaceHeight && scale === this.surfaceScale) {
			return false;
		}
		this.surfaceWidth = width;
		this.surfaceHeight = height;
		this.surfaceScale = scale;
		this.surface.width = Math.round(width * scale);
		this.surface.height = Math.round(height * scale);
		this.surface.style.width = `${width}px`;
		this.surface.style.height = `${height}px`;
		return true;
	}

	/**
	 * Draw every peer's cursor where its canvas-space point lands on the
	 * surface: the wrapper's center is the viewport's center, offset by the
	 * point's distance from it at the current scale. Glyphs and labels are
	 * drawn at screen size whatever the zoom.
	 */
	private draw(): void {
		const ctx = this.ctx;
		if (!ctx || this.destroyed) return;
		this.sizeSurface();
		const rect = this.canvas.canvasRect;
		const width = this.surfaceWidth;
		const height = this.surfaceHeight;
		const dpr = this.surfaceScale || 1;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		const drawn: DrawnCursor[] = [];
		if (!rect) return;
		const scale = this.canvas.scale || 1;
		const now = this.now();
		for (const [clientId, peer] of this.peers) {
			const point = peer.cursorPoint;
			let alpha = 1;
			if (peer.staleAt !== null) {
				alpha = Math.max(0, 1 - (now - peer.staleAt) / CURSOR_FADE_MS);
			}
			const glyph = glyphFor(peer.shape) ?? glyphFor(DEFAULT_CURSOR_SHAPE);
			const visible = point !== null && alpha > 0;
			let sx: number | null = null;
			let sy: number | null = null;
			if (point) {
				sx = width / 2 + (point.x - this.canvas.x) * scale;
				sy = height / 2 + (point.y - this.canvas.y) * scale;
			}
			drawn.push({
				clientId,
				label: peer.name,
				color: peer.color,
				shape: peer.shape,
				glyph: glyph !== null,
				visible,
				x: point?.x ?? null,
				y: point?.y ?? null,
				sx,
				sy,
				alpha,
			});
			if (!visible || sx === null || sy === null) continue;
			ctx.save();
			ctx.globalAlpha = alpha;
			ctx.translate(sx, sy);
			if (glyph) {
				ctx.save();
				ctx.scale(GLYPH_SIZE / ICON_GRID, GLYPH_SIZE / ICON_GRID);
				ctx.lineJoin = "round";
				ctx.lineCap = "round";
				if (glyph.filled) {
					ctx.lineWidth = 1.5 * (ICON_GRID / GLYPH_SIZE);
					ctx.strokeStyle = "#fff";
					ctx.fillStyle = peer.color;
					for (const path of glyph.paths) {
						ctx.stroke(path);
						ctx.fill(path);
					}
				} else {
					ctx.lineWidth = 2;
					ctx.strokeStyle = peer.color;
					for (const path of glyph.paths) ctx.stroke(path);
				}
				ctx.restore();
			}
			if (peer.name) {
				ctx.font = this.labelFont;
				ctx.textBaseline = "middle";
				const textWidth = ctx.measureText(peer.name).width;
				const boxX = GLYPH_SIZE - 4;
				const boxY = GLYPH_SIZE - 4;
				const boxWidth = textWidth + LABEL_PAD_X * 2;
				ctx.fillStyle = peer.color;
				roundedRect(ctx, boxX, boxY, boxWidth, LABEL_HEIGHT, LABEL_RADIUS);
				ctx.fill();
				ctx.fillStyle = "#fff";
				ctx.fillText(peer.name, boxX + LABEL_PAD_X, boxY + LABEL_HEIGHT / 2);
			}
			ctx.restore();
		}
		(this.surface as unknown as { relayPresenceCursors: DrawnCursor[] }).relayPresenceCursors = drawn;
	}

	private clearStaleTimer(peer: Peer): void {
		if (peer.staleTimer !== null) {
			this.options.timeProvider.clearTimeout(peer.staleTimer);
			peer.staleTimer = null;
		}
	}

	/**
	 * Mirror the peer's active items: each of Obsidian's state classes on
	 * the peer's element becomes the peer-prefixed class on the local
	 * element, in the peer's color, and a node with live geometry gets a
	 * ghost at that geometry, played on the same delayed trail as the cursor.
	 */
	private renderItems(peer: Peer, state: CanvasPresenceState): void {
		const wanted = new Set(Object.keys(state.items));
		for (const [id, item] of Object.entries(state.items)) {
			const els = this.elementsFor(id);
			if (els.length === 0) {
				wanted.delete(id);
				continue;
			}
			let applied = peer.items.get(id);
			if (applied && !sameElements(applied.els, els)) {
				this.clearItem(applied);
				applied = undefined;
			}
			if (!applied) {
				applied = { els, classes: [], live: null };
				peer.items.set(id, applied);
			}
			for (const name of applied.classes) {
				if (!item.classes.includes(name)) {
					for (const el of els) el.classList.remove(PEER_CLASS_PREFIX + name);
				}
			}
			for (const name of item.classes) {
				for (const el of els) el.classList.add(PEER_CLASS_PREFIX + name);
			}
			for (const el of els) {
				(el as HTMLElement).style.setProperty(COLOR_PROPERTY, peer.color);
			}
			applied.classes = [...item.classes];
			this.renderLive(applied, item, id, state);
		}
		for (const [id, applied] of Array.from(peer.items)) {
			if (!wanted.has(id)) {
				this.clearItem(applied);
				peer.items.delete(id);
			}
		}
	}

	/** The local elements standing for a node or edge id. */
	private elementsFor(id: string): Element[] {
		const node = this.canvas.nodes.get(id);
		if (node) return [node.nodeEl];
		const edge = this.canvas.edges.get(id);
		if (edge) return [edge.lineGroupEl, edge.lineEndGroupEl];
		return [];
	}

	private clearItem(applied: AppliedItem): void {
		for (const el of applied.els) {
			for (const name of applied.classes) el.classList.remove(PEER_CLASS_PREFIX + name);
			(el as HTMLElement).style.removeProperty(COLOR_PROPERTY);
		}
		applied.classes = [];
		if (applied.live) {
			this.releaseLive(applied.live);
			applied.live = null;
		}
	}

	/**
	 * Show the node where the peer has it. The live geometry rides a
	 * delayed trail like the cursor; each sample is written onto the local
	 * node element. When the peer's drag ends the geometry leaves the
	 * state, and the element holds its last live geometry until the model
	 * catches up (the drop lands in the CRDT and Obsidian re-renders) or
	 * the hold expires (the drag was cancelled), whichever comes first.
	 */
	private renderLive(
		applied: AppliedItem,
		item: CanvasPresenceItem,
		id: string,
		state: CanvasPresenceState,
	): void {
		const geometry = item.geometry;
		const el = applied.els[0] as HTMLElement | undefined;
		if (!geometry || !el) {
			if (applied.live && applied.live.holdTimer === null) this.holdLive(applied.live);
			return;
		}
		const anchor = state.anchor;
		const attached = anchor && "node" in anchor && anchor.node === id ? anchor : null;
		const value: GhostValue = {
			...geometry,
			dx: attached?.dx ?? 0,
			dy: attached?.dy ?? 0,
		};
		const now = this.now();
		if (!applied.live || applied.live.el !== el) {
			if (applied.live) this.releaseLive(applied.live);
			const track = new PointTrack<GhostValue>();
			track.push(now, value);
			applied.live = { nodeId: id, el, track, holdTimer: null };
			this.placeLive(applied.live, value);
			return;
		}
		const live = applied.live;
		if (live.holdTimer !== null) {
			// The drag resumed before the model caught up.
			this.options.timeProvider.clearTimeout(live.holdTimer);
			live.holdTimer = null;
		}
		const latest = live.track.latest();
		if (
			!latest ||
			latest.x !== value.x ||
			latest.y !== value.y ||
			latest.width !== value.width ||
			latest.height !== value.height ||
			latest.dx !== value.dx ||
			latest.dy !== value.dy
		) {
			live.track.push(now, value);
			this.startMotion();
		}
	}

	/** The same three styles and two custom properties Obsidian's node render writes, then its edges. */
	private placeLive(live: Live, geometry: CanvasPresenceGeometry): void {
		const style = live.el.style;
		style.transform = `translate(${geometry.x}px, ${geometry.y}px)`;
		style.width = `${geometry.width}px`;
		style.height = `${geometry.height}px`;
		style.setProperty("--canvas-node-width", `${geometry.width}px`);
		style.setProperty("--canvas-node-height", `${geometry.height}px`);
		this.liveBounds.set(live.nodeId, {
			minX: geometry.x,
			minY: geometry.y,
			maxX: geometry.x + geometry.width,
			maxY: geometry.y + geometry.height,
		});
		this.routeEdges(live.nodeId);
	}

	/**
	 * Obsidian re-routes a moved node's edges by re-rendering them from the
	 * node's bounds. Do the same for a node a peer is moving: while Obsidian's
	 * edge render runs, every live node answers its live bounds instead of
	 * the model's, through an instance method that shadows the prototype
	 * and is removed again before anything else can see it.
	 */
	private routeEdges(nodeId: string): void {
		const node = this.canvas.nodes.get(nodeId);
		if (!node) return;
		const edges = this.canvas.getEdgesForNode(node);
		if (edges.length === 0) return;
		const shadowed: Array<{ node: CanvasNode; had: boolean; previous: CanvasNode["getBBox"] }> = [];
		for (const [id, bounds] of this.liveBounds) {
			const target = this.canvas.nodes.get(id);
			if (!target) continue;
			const had = Object.prototype.hasOwnProperty.call(target, "getBBox");
			shadowed.push({ node: target, had, previous: target.getBBox });
			target.getBBox = () => bounds;
		}
		try {
			for (const edge of edges) edge.render();
		} finally {
			for (const entry of shadowed) {
				if (entry.had) entry.node.getBBox = entry.previous;
				else delete (entry.node as { getBBox?: CanvasNode["getBBox"] }).getBBox;
			}
		}
	}

	/** The peer's drag ended: wait for the model, then let Obsidian render. */
	private holdLive(live: Live): void {
		live.holdTimer = this.options.timeProvider.setTimeout(() => {
			live.holdTimer = null;
			this.restoreNode(live.nodeId);
			for (const peer of this.peers.values()) {
				for (const applied of peer.items.values()) {
					if (applied.live === live) applied.live = null;
				}
			}
		}, LIVE_GEOMETRY_HOLD_MS);
	}

	private releaseLive(live: Live): void {
		if (live.holdTimer !== null) {
			this.options.timeProvider.clearTimeout(live.holdTimer);
			live.holdTimer = null;
		}
		this.restoreNode(live.nodeId);
	}

	/** Hand the element back: Obsidian's own frame re-renders the node and its edges from the model. */
	private restoreNode(nodeId: string): void {
		this.liveBounds.delete(nodeId);
		const node = this.canvas.nodes.get(nodeId);
		if (node) this.canvas.markMoved(node);
	}

	/**
	 * The model moved: a held node has caught up, and a node still being
	 * played must be re-applied after Obsidian's render of the model.
	 */
	modelChanged(): void {
		for (const peer of this.peers.values()) {
			const live = peer.edgeLive;
			if (live && live.holdTimer !== null) {
				this.options.timeProvider.clearTimeout(live.holdTimer);
				peer.edgeLive = null;
			}
			for (const applied of peer.items.values()) {
				const live = applied.live;
				if (!live) continue;
				if (live.holdTimer !== null) {
					this.options.timeProvider.clearTimeout(live.holdTimer);
					live.holdTimer = null;
					this.liveBounds.delete(live.nodeId);
					applied.live = null;
				}
			}
		}
	}

	/**
	 * The connection a peer is drawing. An edge the local canvas already has
	 * is drawn in place with the live ends, the way Obsidian moves an edge
	 * end locally; when the drag ends the edge holds until the model catches
	 * up or a short hold expires, then Obsidian renders it from the model. A
	 * connection the canvas does not have yet is an Obsidian edge in the
	 * peer's color whose far end is a sizeless point, the way Obsidian's own
	 * placeholder node works during the drag.
	 */
	private renderEdge(peer: Peer, state: CanvasPresenceState, clientId?: number): void {
		const spec = state.edge;
		const from = spec ? this.resolveEnd(spec.from, spec.to, "none", peer) : null;
		const to = spec ? this.resolveEnd(spec.to, spec.from, "arrow", peer) : null;
		if (!spec || !from || !to) {
			if (peer.edge) {
				peer.edge.destroy();
				peer.edge = null;
			}
			if (peer.edgeLive && peer.edgeLive.holdTimer === null) this.holdEdge(peer);
			peer.liveEnds = null;
			peer.floatingTrack = null;
			return;
		}
		const existing = spec.id ? this.canvas.edges.get(spec.id) : undefined;
		if (existing) {
			if (peer.edge) {
				peer.edge.destroy();
				peer.edge = null;
			}
			if (peer.edgeLive && peer.edgeLive.edge !== existing) this.releaseEdge(peer);
			if (!peer.edgeLive) {
				peer.edgeLive = { edge: existing, holdTimer: null };
			} else if (peer.edgeLive.holdTimer !== null) {
				this.options.timeProvider.clearTimeout(peer.edgeLive.holdTimer);
				peer.edgeLive.holdTimer = null;
			}
		} else {
			if (peer.edgeLive) this.releaseEdge(peer);
			if (!peer.edge || !edgeConstructor) {
				if (!edgeConstructor) return;
				const id = `relay-presence-${clientId ?? "peer"}`;
				const edge = new edgeConstructor(this.canvas, id, from, to);
				edge.lineGroupEl.classList.add(PRESENCE_EDGE_CLASS);
				edge.lineEndGroupEl.classList.add(PRESENCE_EDGE_CLASS);
				edge.attach();
				peer.edge = edge;
			}
		}
		peer.liveEnds = { from, to };
		this.drawLiveEdge(peer);
	}

	/** Render the peer's live edge from its current ends. */
	private drawLiveEdge(peer: Peer): void {
		const ends = peer.liveEnds;
		if (!ends) return;
		if (peer.edgeLive) {
			// The local copy of the edge, rendered with the live ends in
			// place of the model's for the duration of that render only.
			const edge = peer.edgeLive.edge;
			const savedFrom = edge.from;
			const savedTo = edge.to;
			edge.from = ends.from;
			edge.to = ends.to;
			try {
				edge.render();
			} finally {
				edge.from = savedFrom;
				edge.to = savedTo;
			}
			return;
		}
		if (peer.edge) {
			peer.edge.from = ends.from;
			peer.edge.to = ends.to;
			peer.edge.color = peer.color;
			peer.edge.render();
		}
	}

	/** The peer's edge drag ended: hold the live ends for the model to catch up, then hand back. */
	private holdEdge(peer: Peer): void {
		const live = peer.edgeLive;
		if (!live) return;
		live.holdTimer = this.options.timeProvider.setTimeout(() => {
			live.holdTimer = null;
			if (peer.edgeLive === live) this.releaseEdge(peer);
		}, LIVE_GEOMETRY_HOLD_MS);
	}

	/** Hand the edge back: Obsidian's own frame re-renders it from the model. */
	private releaseEdge(peer: Peer): void {
		const live = peer.edgeLive;
		if (!live) return;
		if (live.holdTimer !== null) this.options.timeProvider.clearTimeout(live.holdTimer);
		peer.edgeLive = null;
		if (this.canvas.edges.get(live.edge.id) === live.edge) this.canvas.markMoved(live.edge);
	}

	private resolveEnd(
		end: CanvasPresenceEdgeEnd,
		other: CanvasPresenceEdgeEnd,
		style: CanvasEdgeEndStyle,
		peer: Peer,
	): CanvasEdgeEnd | null {
		if ("node" in end) {
			const node = this.canvas.nodes.get(end.node);
			return node ? { node, side: end.side, end: style } : null;
		}
		// A floating end faces the anchored end, as Obsidian's placeholder
		// does, and moves on the same delayed trail as the cursor so the two
		// stay together on screen.
		const side: CanvasSide = "node" in other ? OPPOSITE[other.side] : "left";
		const floating = peer.floatingEnd ?? new FloatingEnd("relay-presence-floating");
		peer.floatingEnd = floating;
		const anchor = peer.state?.anchor;
		const value: FloatingValue = {
			x: end.x,
			y: end.y,
			dx: anchor && "edge" in anchor ? anchor.dx : 0,
			dy: anchor && "edge" in anchor ? anchor.dy : 0,
		};
		const now = this.now();
		if (!peer.floatingTrack) {
			peer.floatingTrack = new PointTrack<FloatingValue>();
			peer.floatingTrack.push(now, value);
			floating.x = end.x;
			floating.y = end.y;
		} else {
			const latest = peer.floatingTrack.latest();
			if (
				!latest ||
				latest.x !== value.x ||
				latest.y !== value.y ||
				latest.dx !== value.dx ||
				latest.dy !== value.dy
			) {
				peer.floatingTrack.push(now, value);
				this.startMotion();
			}
		}
		return { node: floating, side, end: style };
	}

	private removePeer(clientId: number, peer: Peer): void {
		peer.cursorTrack = null;
		peer.anchor = null;
		peer.floatingTrack = null;
		this.clearStaleTimer(peer);
		peer.edge?.destroy();
		peer.edge = null;
		this.releaseEdge(peer);
		peer.liveEnds = null;
		for (const applied of peer.items.values()) this.clearItem(applied);
		peer.items.clear();
		this.peers.delete(clientId);
		this.requestDraw();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.bind(null);
		const win = this.surface.ownerDocument.defaultView;
		if (win) {
			for (const frame of [this.viewportFrame, this.geometryFrame, this.motionFrame, this.drawFrame, this.fadeFrame]) {
				if (frame !== null) win.cancelAnimationFrame(frame);
			}
		}
		this.viewportFrame = null;
		this.geometryFrame = null;
		this.motionFrame = null;
		this.drawFrame = null;
		this.fadeFrame = null;
		for (const [clientId, peer] of Array.from(this.peers)) {
			this.removePeer(clientId, peer);
		}
		this.liveBounds.clear();
		this.surface.remove();
		this.canvas = null as unknown as typeof this.canvas;
	}
}

function sameElements(a: Element[], b: Element[]): boolean {
	return a.length === b.length && a.every((el, i) => el === b[i]);
}

function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): void {
	const r = Math.min(radius, width / 2, height / 2);
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + width - r, y);
	ctx.arcTo(x + width, y, x + width, y + r, r);
	ctx.lineTo(x + width, y + height - r);
	ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
	ctx.lineTo(x + r, y + height);
	ctx.arcTo(x, y + height, x, y + height - r, r);
	ctx.lineTo(x, y + r);
	ctx.arcTo(x, y, x + r, y, r);
	ctx.closePath();
}
