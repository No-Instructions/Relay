import type { CanvasPoint } from "../CanvasView";
import type { TimeProvider } from "../TimeProvider";
import {
	pointsEqual,
	roundPoint,
	roundViewport,
	viewportsEqual,
} from "./geometry";
import {
	DEFAULT_CURSOR_SHAPE,
	emptyCanvasPresence,
	type CanvasPresenceAnchor,
	type CanvasPresenceEdge,
	type CanvasPresenceItem,
	type CanvasPresenceState,
	type CanvasPresenceViewport,
} from "./types";

/** Minimum spacing of publishes driven by the pointer or anything that follows it. */
export const CURSOR_INTERVAL_MS = 25;
/**
 * The cursor traffic a viewer should have to take in per second. Every
 * sender spaces its cursor publishes so that this many active peers, each
 * sending at the same spacing, add up to the budget; with few peers the
 * spacing stays at the cursor interval.
 */
export const INBOUND_CURSOR_BUDGET_PER_S = 240;

/** The cursor publish spacing for a sender that sees this many other active peers. */
export function cursorIntervalFor(activePeers: number): number {
	if (activePeers <= 0) return CURSOR_INTERVAL_MS;
	return Math.max(CURSOR_INTERVAL_MS, Math.ceil((1000 * activePeers) / INBOUND_CURSOR_BUDGET_PER_S));
}
/** Minimum spacing of publishes driven by pan, zoom, and resize. */
export const VIEWPORT_INTERVAL_MS = 200;
/** Minimum spacing of publishes driven by item state changes. */
export const SELECTION_INTERVAL_MS = 50;

export type CanvasPresenceSink = (state: CanvasPresenceState) => void;

export interface CanvasPresencePublisherOptions {
	timeProvider: TimeProvider;
	sink: CanvasPresenceSink;
	cursorIntervalMs?: number;
	viewportIntervalMs?: number;
	selectionIntervalMs?: number;
}

function edgesEqual(
	a: CanvasPresenceEdge | null,
	b: CanvasPresenceEdge | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

function anchorsEqual(
	a: CanvasPresenceAnchor | null,
	b: CanvasPresenceAnchor | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

function roundAnchor(anchor: CanvasPresenceAnchor | null): CanvasPresenceAnchor | null {
	if (!anchor) return null;
	const dx = Math.round(anchor.dx);
	const dy = Math.round(anchor.dy);
	return "node" in anchor ? { node: anchor.node, dx, dy } : { edge: true, dx, dy };
}

/** Integer geometry so sub-pixel motion is not a change. */
function normalizeItems(
	items: Record<string, CanvasPresenceItem>,
): Record<string, CanvasPresenceItem> {
	const out: Record<string, CanvasPresenceItem> = {};
	for (const id of Object.keys(items).sort()) {
		const item = items[id];
		const classes = Array.from(new Set(item.classes)).sort();
		const geometry = item.geometry
			? {
					x: Math.round(item.geometry.x),
					y: Math.round(item.geometry.y),
					width: Math.round(item.geometry.width),
					height: Math.round(item.geometry.height),
				}
			: undefined;
		if (classes.length === 0 && !geometry) continue;
		out[id] = geometry ? { classes, geometry } : { classes };
	}
	return out;
}

function itemsEqual(
	a: Record<string, CanvasPresenceItem>,
	b: Record<string, CanvasPresenceItem>,
): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function hasGeometry(items: Record<string, CanvasPresenceItem>): boolean {
	return Object.values(items).some((item) => item.geometry !== undefined);
}

function cloneItems(
	items: Record<string, CanvasPresenceItem>,
): Record<string, CanvasPresenceItem> {
	const out: Record<string, CanvasPresenceItem> = {};
	for (const [id, item] of Object.entries(items)) {
		out[id] = item.geometry
			? { classes: [...item.classes], geometry: { ...item.geometry } }
			: { classes: [...item.classes] };
	}
	return out;
}

/**
 * Coalesces local presence changes into rate-limited publishes. An
 * awareness update always carries the whole state, so there is one pending
 * flush at a time; each channel only bounds how soon after the previous
 * publish its own change may go out, and a faster channel becoming dirty
 * pulls the pending flush earlier. Nothing publishes while nothing changes.
 */
export class CanvasPresencePublisher {
	private readonly time: TimeProvider;
	private readonly sink: CanvasPresenceSink;
	private cursorInterval: number;
	private readonly viewportInterval: number;
	private readonly selectionInterval: number;
	private state: CanvasPresenceState = emptyCanvasPresence();
	private dirty = false;
	private timer: number | null = null;
	private dueAt: number | null = null;
	private lastFlushAt = Number.NEGATIVE_INFINITY;
	private stopped = false;

	constructor(options: CanvasPresencePublisherOptions) {
		this.time = options.timeProvider;
		this.sink = options.sink;
		this.cursorInterval = options.cursorIntervalMs ?? CURSOR_INTERVAL_MS;
		this.viewportInterval = options.viewportIntervalMs ?? VIEWPORT_INTERVAL_MS;
		this.selectionInterval =
			options.selectionIntervalMs ?? SELECTION_INTERVAL_MS;
	}

	/** Change the spacing of pointer-driven publishes; takes effect from the next change. */
	setCursorInterval(ms: number): void {
		this.cursorInterval = Math.max(1, ms);
	}

	/** A snapshot of the state the next publish carries. */
	get current(): CanvasPresenceState {
		return {
			...this.state,
			viewport: this.state.viewport ? { ...this.state.viewport } : null,
			cursor: this.state.cursor ? { ...this.state.cursor } : null,
			anchor: this.state.anchor ? { ...this.state.anchor } : null,
			items: cloneItems(this.state.items),
			edge: this.state.edge ? { ...this.state.edge } : null,
		};
	}

	/**
	 * The pointer is over the canvas at this canvas-space point, wearing
	 * this CSS cursor, and attached to an item at this offset if any.
	 */
	setCursor(
		point: CanvasPoint,
		shape: string = DEFAULT_CURSOR_SHAPE,
		anchor: CanvasPresenceAnchor | null = null,
	): void {
		const cursor = roundPoint(point);
		const rounded = roundAnchor(anchor);
		if (
			this.state.mode === "active" &&
			pointsEqual(this.state.cursor, cursor) &&
			this.state.shape === shape &&
			anchorsEqual(this.state.anchor, rounded)
		) {
			return;
		}
		this.state = { ...this.state, mode: "active", cursor, shape, anchor: rounded };
		this.schedule(this.cursorInterval);
	}

	/** The pointer left the canvas, or the window lost focus. */
	clearCursor(): void {
		if (
			this.state.mode === "attached" &&
			this.state.cursor === null &&
			this.state.edge === null
		) {
			return;
		}
		this.state = {
			...this.state,
			mode: "attached",
			cursor: null,
			shape: DEFAULT_CURSOR_SHAPE,
			anchor: null,
			edge: null,
		};
		this.schedule(0);
	}

	setViewport(viewport: CanvasPresenceViewport): void {
		const rounded = roundViewport(viewport);
		if (viewportsEqual(this.state.viewport, rounded)) return;
		this.state = { ...this.state, viewport: rounded };
		this.schedule(this.viewportInterval);
	}

	/**
	 * The viewer's active items. Live geometry follows the pointer, so a
	 * set that carries any publishes at the cursor rate; the end of a drag
	 * publishes promptly so peers drop the ghost.
	 */
	setItems(items: Record<string, CanvasPresenceItem>): void {
		const normalized = normalizeItems(items);
		if (itemsEqual(this.state.items, normalized)) return;
		const wasMoving = hasGeometry(this.state.items);
		const moving = hasGeometry(normalized);
		this.state = { ...this.state, items: normalized };
		this.schedule(
			moving ? this.cursorInterval : wasMoving ? 0 : this.selectionInterval,
		);
	}

	/** A connection being drawn follows the pointer, so it shares the cursor rate. */
	setEdge(edge: CanvasPresenceEdge | null): void {
		if (edgesEqual(this.state.edge, edge)) return;
		this.state = { ...this.state, edge };
		this.schedule(this.cursorInterval);
	}

	/** Publish the current state again: the awareness field was reset. */
	republish(): void {
		this.schedule(0);
	}

	destroy(): void {
		this.stopped = true;
		this.dirty = false;
		if (this.timer !== null) {
			this.time.clearTimeout(this.timer);
			this.timer = null;
		}
		this.dueAt = null;
	}

	private schedule(minInterval: number): void {
		if (this.stopped) return;
		this.dirty = true;
		const now = this.time.now();
		const due = Math.max(now, this.lastFlushAt + minInterval);
		if (this.dueAt !== null && this.dueAt <= due) {
			// An earlier flush is pending and carries this change.
			return;
		}
		if (this.timer !== null) {
			this.time.clearTimeout(this.timer);
		}
		this.dueAt = due;
		this.timer = this.time.setTimeout(() => this.flush(), due - now);
	}

	private flush(): void {
		this.timer = null;
		this.dueAt = null;
		if (this.stopped || !this.dirty) return;
		this.dirty = false;
		this.lastFlushAt = this.time.now();
		this.sink(this.current);
	}
}
