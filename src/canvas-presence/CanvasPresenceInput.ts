import { getPatcher } from "../Patcher";
import type {
	CanvasEdge,
	CanvasEdgeEnd,
	ObsidianCanvas,
} from "../CanvasView";
import type { TimeProvider } from "../TimeProvider";
import type { CanvasPresencePublisher } from "./CanvasPresencePublisher";
import { roundPoint } from "./geometry";
import {
	DEFAULT_CURSOR_SHAPE,
	STATE_CLASSES,
	isCursorKeyword,
	type CanvasPresenceAnchor,
	type CanvasPresenceEdge,
	type CanvasPresenceEdgeEnd,
	type CanvasPresenceItem,
	type StateClass,
} from "./types";

/** Obsidian marks the canvas element with this class for the length of a connection drag. */
export const CONNECTING_CLASS = "is-connecting";
/** Obsidian marks the wrapper with this class for the length of any pointer drag. */
const DRAGGING_CLASS = "is-dragging";
/** How often the viewport is read while a pan or zoom animates. */
const VIEWPORT_SAMPLE_MS = 100;
/** How often a connection being drawn is read while the drag lasts. */
const CONNECTION_SAMPLE_MS = 50;
/** Surfaces over which a browser resolves cursor "auto" to the text I-beam. */
const EDITABLE_SELECTOR = '.cm-content, [contenteditable="true"], textarea, input';

export interface CanvasPresenceInputHooks {
	/** The local viewport started changing. Fires on every pan, zoom, and resize. */
	onViewportChanging?: () => void;
	/** A node or edge is about to be re-rendered from the model, so anything placed on it is stale. */
	onItemMoved?: () => void;
	/** Obsidian added an edge to the canvas, including the provisional one of a drag. */
	onEdgeAdded?: (edge: CanvasEdge) => void;
}

type PatchedMethod = (...args: unknown[]) => unknown;

interface CursorCacheEntry {
	buttons: number;
	dragging: boolean;
	shape: string;
}

/**
 * Reads the local viewer off Obsidian's canvas and feeds the publisher.
 * Obsidian expresses every active state as a class on a node or edge
 * element and every in-flight geometry as the node's live coordinates, so
 * one class observer plus the move hook captures all of them without
 * knowing what each state means; the pointer's shape is whatever CSS
 * cursor the element under it resolves to.
 */
export class CanvasPresenceInput {
	private unsubscribes: Array<() => void> = [];
	private viewportTimer: number | null = null;
	private classObserver: MutationObserver | null = null;
	/** The edge being drawn, remembered so it is still reported while snapped to a target. */
	private pendingEdgeId: string | null = null;
	/** Runs while a connection drag is active; the placeholder follows the pointer without passing through the wrapper. */
	private connectionTimer: number | null = null;
	/** The pointer's last screen position, re-projected when the viewport moves under it. */
	private lastClient: { x: number; y: number } | null = null;
	/** False once the pointer has left the wrapper, whether or not a drag keeps the cursor alive. */
	private pointerInside = false;
	/**
	 * The same-origin iframe inside the wrapper the pointer is in, if any.
	 * Card editors live in such iframes; the parent document sees the pointer
	 * leave the wrapper on entry and hears nothing more until it comes out.
	 */
	private frame: { el: HTMLIFrameElement; doc: Document; off: () => void } | null = null;
	private lastTarget: Element | null = null;
	private lastButtons = 0;
	private lastShape = DEFAULT_CURSOR_SHAPE;
	/** Computed cursor per element, valid while the button and drag state match. */
	private cursorCache = new WeakMap<Element, CursorCacheEntry>();
	private itemsQueued = false;
	private pointerQueued = false;
	private destroyed = false;

	constructor(
		private canvas: ObsidianCanvas,
		private publisher: CanvasPresencePublisher,
		private timeProvider: TimeProvider,
		private hooks: CanvasPresenceInputHooks = {},
	) {
		this.install();
	}

	private install(): void {
		const { wrapperEl, canvasEl } = this.canvas;
		const doc = wrapperEl.ownerDocument;
		const win = doc.defaultView;

		const onPointer = (evt: PointerEvent) => {
			if (this.destroyed || evt.pointerType === "touch") return;
			if (this.frame && !(evt.target instanceof HTMLIFrameElement)) this.exitFrame();
			this.pointerInside = true;
			this.lastClient = { x: evt.clientX, y: evt.clientY };
			this.lastTarget = evt.target instanceof Element ? evt.target : null;
			this.lastButtons = evt.buttons;
			this.lastShape = this.shapeUnderPointer();
			if (this.isDragging()) {
				// Obsidian moves the dragged item from its own listener on the
				// window, which runs after this one; publish once it has, so
				// the item, the pointer, and the pointer's offset from the
				// item are all read from the same moment.
				this.queuePointer();
			} else {
				this.publishPointer();
			}
		};
		// Obsidian keeps a drag alive after the pointer leaves the view,
		// auto-panning toward it; the pointer is still attached to the item,
		// so the cursor stays and follows from the window until the drag ends.
		const onWindowPointer = (evt: PointerEvent) => {
			if (this.destroyed || evt.pointerType === "touch") return;
			if (this.pointerInside || !this.isDragging()) return;
			this.lastClient = { x: evt.clientX, y: evt.clientY };
			this.lastButtons = evt.buttons;
			this.queuePointer();
		};
		// An iframe inside the wrapper is still inside it: the parent sees the
		// pointer arrive over the frame element and then hears nothing more
		// while the frame's own document receives the moves.
		const onPointerOver = (evt: PointerEvent) => {
			if (this.destroyed) return;
			const target = evt.target;
			if (target instanceof HTMLIFrameElement && this.frameAccessible(target)) {
				this.enterFrame(target);
			}
		};
		const onPointerLeave = (evt: PointerEvent) => {
			const frame = this.frameUnder(evt);
			if (frame) {
				// A pop-out or a frame that reports as outside: follow it.
				this.enterFrame(frame);
				return;
			}
			this.pointerInside = false;
			// A drag in progress keeps the cursor; the leave lands when it ends.
			if (this.isDragging()) return;
			this.leave();
		};
		const onVisibilityChange = () => {
			if (doc.visibilityState === "hidden") {
				this.pointerInside = false;
				this.leave();
			}
		};
		const onWindowBlur = () => {
			this.pointerInside = false;
			this.leave();
		};
		wrapperEl.addEventListener("pointermove", onPointer, { passive: true });
		wrapperEl.addEventListener("pointerdown", onPointer, { passive: true });
		wrapperEl.addEventListener("pointerup", onPointer, { passive: true });
		wrapperEl.addEventListener("pointerover", onPointerOver, { passive: true });
		wrapperEl.addEventListener("pointerleave", onPointerLeave);
		win?.addEventListener("pointermove", onWindowPointer, { passive: true });
		win?.addEventListener("pointerup", onWindowPointer, { passive: true });
		win?.addEventListener("blur", onWindowBlur);
		doc.addEventListener("visibilitychange", onVisibilityChange);
		this.unsubscribes.push(() => {
			wrapperEl.removeEventListener("pointermove", onPointer);
			wrapperEl.removeEventListener("pointerdown", onPointer);
			wrapperEl.removeEventListener("pointerup", onPointer);
			wrapperEl.removeEventListener("pointerover", onPointerOver);
			wrapperEl.removeEventListener("pointerleave", onPointerLeave);
			win?.removeEventListener("pointermove", onWindowPointer);
			win?.removeEventListener("pointerup", onWindowPointer);
			win?.removeEventListener("blur", onWindowBlur);
			doc.removeEventListener("visibilitychange", onVisibilityChange);
		});

		const input = () => this;
		this.unsubscribes.push(
			getPatcher().patch(this.canvas, {
				markViewportChanged(old: PatchedMethod) {
					return function (this: unknown, ...args: unknown[]) {
						const res = old.apply(this, args);
						input().onViewportChanged();
						return res;
					};
				},
				onResize(old: PatchedMethod) {
					return function (this: unknown, ...args: unknown[]) {
						const res = old.apply(this, args);
						input().onViewportChanged();
						return res;
					};
				},
				markMoved(old: PatchedMethod) {
					return function (this: unknown, ...args: unknown[]) {
						const res = old.apply(this, args);
						input().onItemMoved();
						return res;
					};
				},
				markDirty(old: PatchedMethod) {
					return function (this: unknown, ...args: unknown[]) {
						const res = old.apply(this, args);
						input().onItemMoved();
						return res;
					};
				},
				setDragging(old: PatchedMethod) {
					return function (this: unknown, ...args: unknown[]) {
						const res = old.apply(this, args);
						input().onDraggingChanged();
						return res;
					};
				},
				addEdge(old: PatchedMethod) {
					return function (this: unknown, ...args: unknown[]) {
						const res = old.apply(this, args);
						input().notifyEdgeAdded(args[0] as CanvasEdge);
						return res;
					};
				},
			}),
		);

		if (typeof MutationObserver !== "undefined") {
			// One observer for every class Obsidian toggles on the canvas: the
			// connection drag on the canvas element itself, and the state
			// classes on node and edge elements below it.
			this.classObserver = new MutationObserver((records) => {
				if (this.destroyed) return;
				let items = false;
				let connection = false;
				for (const record of records) {
					if (record.target === canvasEl) connection = true;
					else items = true;
				}
				if (connection) this.sampleConnection();
				if (items) this.queueItems();
			});
			this.classObserver.observe(canvasEl, {
				attributes: true,
				attributeFilter: ["class"],
				subtree: true,
			});
		}

		this.sampleViewport();
		this.sampleItems();
	}

	private frameAccessible(el: HTMLIFrameElement): boolean {
		if (!this.canvas.wrapperEl.contains(el)) return false;
		try {
			return !!el.contentDocument;
		} catch {
			return false;
		}
	}

	/** The same-origin iframe within the wrapper under a pointer event, if the pointer moved into one. */
	private frameUnder(evt: PointerEvent): HTMLIFrameElement | null {
		const wrapper = this.canvas.wrapperEl;
		const candidates: unknown[] = [evt.relatedTarget];
		const doc = wrapper.ownerDocument;
		try {
			candidates.push(doc.elementFromPoint(evt.clientX, evt.clientY));
		} catch {
			// Coordinates outside the viewport; nothing under them.
		}
		for (const candidate of candidates) {
			if (candidate instanceof HTMLIFrameElement && this.frameAccessible(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	/**
	 * Follow the pointer into an iframe: its document reports moves in its
	 * own coordinates, which map back through the frame's box in the parent,
	 * scaled since the canvas transform scales the frame visually but not
	 * its layout.
	 */
	private enterFrame(el: HTMLIFrameElement): void {
		const frameDoc = el.contentDocument;
		if (!frameDoc) return;
		// The same frame can carry a fresh document after its editor reloads.
		if (this.frame?.el === el && this.frame.doc === frameDoc) return;
		this.exitFrame();
		const toParent = (evt: PointerEvent): { x: number; y: number } => {
			const rect = el.getBoundingClientRect();
			const scaleX = el.clientWidth ? rect.width / el.clientWidth : 1;
			const scaleY = el.clientHeight ? rect.height / el.clientHeight : 1;
			return { x: rect.left + evt.clientX * scaleX, y: rect.top + evt.clientY * scaleY };
		};
		const onMove = (evt: PointerEvent) => {
			if (this.destroyed || evt.pointerType === "touch") return;
			this.pointerInside = true;
			this.lastClient = toParent(evt);
			this.lastTarget = evt.target instanceof Element ? evt.target : null;
			this.lastButtons = evt.buttons;
			this.lastShape = this.shapeUnderPointer();
			this.publishPointer();
		};
		const onLeave = (evt: PointerEvent) => {
			const point = toParent(evt);
			this.exitFrame();
			// Out of the frame but still over the canvas: the wrapper's own
			// events resume. Out of both: the pointer has left.
			const rect = this.canvas.wrapperEl.getBoundingClientRect();
			const inside =
				point.x >= rect.left && point.x <= rect.right &&
				point.y >= rect.top && point.y <= rect.bottom;
			if (!inside) {
				this.pointerInside = false;
				if (!this.isDragging()) this.leave();
			}
		};
		frameDoc.addEventListener("pointermove", onMove, { passive: true });
		frameDoc.addEventListener("pointerdown", onMove, { passive: true });
		frameDoc.addEventListener("pointerup", onMove, { passive: true });
		frameDoc.documentElement.addEventListener("pointerleave", onLeave);
		this.frame = {
			el,
			doc: frameDoc,
			off: () => {
				frameDoc.removeEventListener("pointermove", onMove);
				frameDoc.removeEventListener("pointerdown", onMove);
				frameDoc.removeEventListener("pointerup", onMove);
				frameDoc.documentElement.removeEventListener("pointerleave", onLeave);
			},
		};
	}

	private exitFrame(): void {
		if (!this.frame) return;
		try {
			this.frame.off();
		} catch {
			// The frame's document may already be gone with its editor.
		}
		this.frame = null;
	}

	private notifyEdgeAdded(edge: CanvasEdge): void {
		if (this.destroyed || !edge) return;
		this.hooks.onEdgeAdded?.(edge);
	}

	private onItemMoved(): void {
		if (this.destroyed) return;
		this.hooks.onItemMoved?.();
		if (this.isDragging()) this.queueItems();
	}

	private onDraggingChanged(): void {
		if (this.destroyed) return;
		// The drag state changes what the element under the pointer resolves to.
		this.cursorCache = new WeakMap();
		this.queueItems();
		if (!this.isDragging() && !this.pointerInside) {
			// The drag that kept the cursor alive outside the view is over.
			this.leave();
			return;
		}
		if (this.lastClient) {
			this.lastShape = this.shapeUnderPointer();
			this.queuePointer();
		}
	}

	/** The pointer is gone: no cursor, no anchor, nothing to re-project. */
	private leave(): void {
		this.lastClient = null;
		this.lastTarget = null;
		this.publisher.clearCursor();
	}

	private queuePointer(): void {
		if (this.pointerQueued || this.destroyed) return;
		this.pointerQueued = true;
		queueMicrotask(() => {
			this.pointerQueued = false;
			if (!this.destroyed) this.publishPointer();
		});
	}

	/**
	 * Publish the pointer where it is now, attached to whatever it is
	 * dragging. The connection being drawn is sampled first, from the same
	 * placeholder position the anchor offset is then measured against, so
	 * one publish never mixes an old end with a new offset.
	 */
	private publishPointer(): void {
		this.sampleConnection();
		if (!this.lastClient) return;
		const point = this.canvas.posFromClient(this.lastClient);
		this.publisher.setCursor(point, this.lastShape, this.anchorFor(point));
	}

	/**
	 * The item the pointer is attached to and its offset from that item's
	 * origin: a dragged or resized node when one contains the pointer, else
	 * the first one; or the floating end of a connection being drawn.
	 */
	private anchorFor(point: { x: number; y: number }): CanvasPresenceAnchor | null {
		if (!this.isDragging()) return null;
		let first: { id: string; x: number; y: number } | null = null;
		for (const node of this.canvas.nodes.values()) {
			if (!node.nodeEl.classList.contains("is-dragging")) continue;
			first = first ?? node;
			const box = node.getBBox();
			if (
				point.x >= box.minX &&
				point.x <= box.maxX &&
				point.y >= box.minY &&
				point.y <= box.maxY
			) {
				return { node: node.id, dx: point.x - node.x, dy: point.y - node.y };
			}
		}
		if (first) return { node: first.id, dx: point.x - first.x, dy: point.y - first.y };
		const pending = this.pendingEdgeId ? this.canvas.edges.get(this.pendingEdgeId) : undefined;
		if (pending) {
			const floating = this.isPlaceholder(pending.to)
				? pending.to.node
				: this.isPlaceholder(pending.from)
					? pending.from.node
					: null;
			if (floating) return { edge: true, dx: point.x - floating.x, dy: point.y - floating.y };
		}
		return null;
	}

	private isDragging(): boolean {
		return (
			this.canvas.isDragging === true ||
			this.canvas.wrapperEl.classList.contains(DRAGGING_CLASS)
		);
	}

	private onViewportChanged(): void {
		if (this.destroyed) return;
		this.hooks.onViewportChanging?.();
		this.sampleViewport();
		if (this.viewportTimer === null) {
			this.viewportTimer = this.timeProvider.setTimeout(
				() => this.viewportTick(),
				VIEWPORT_SAMPLE_MS,
			);
		}
	}

	/**
	 * The viewport moves toward its target over animation frames after the
	 * change is marked, so keep sampling until the canvas reports it settled;
	 * the last sample is the resting viewport.
	 */
	private viewportTick(): void {
		this.viewportTimer = null;
		if (this.destroyed) return;
		this.sampleViewport();
		if (this.canvas.viewportChanged) {
			this.viewportTimer = this.timeProvider.setTimeout(
				() => this.viewportTick(),
				VIEWPORT_SAMPLE_MS,
			);
		}
	}

	sampleViewport(): void {
		const rect = this.canvas.canvasRect;
		if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
		const bbox = this.canvas.getViewportBBox();
		this.publisher.setViewport({ ...bbox, zoom: this.canvas.zoom });
		// A pan or zoom moves the canvas under a resting pointer; the cursor
		// stays where the pointer is on screen, not where it was in canvas space.
		if (this.lastClient) this.publishPointer();
	}

	/**
	 * The CSS cursor the element under the pointer resolves to, which is
	 * Obsidian's own answer to what the pointer looks like there. Read once
	 * per element while the button and drag state hold, since the computed
	 * style is only worth asking for when one of those changes.
	 */
	private shapeUnderPointer(): string {
		const target = this.lastTarget;
		if (!target || !target.isConnected) return DEFAULT_CURSOR_SHAPE;
		const dragging = this.isDragging();
		const cached = this.cursorCache.get(target);
		if (cached && cached.buttons === this.lastButtons && cached.dragging === dragging) {
			return cached.shape;
		}
		const win = target.ownerDocument.defaultView;
		let shape = DEFAULT_CURSOR_SHAPE;
		if (win) {
			const raw = win.getComputedStyle(target).cursor;
			// A cursor list may lead with images; the keyword is its last entry.
			const keyword = raw.split(",").pop()?.trim() ?? "";
			if (keyword === "auto") {
				// "auto" leaves the choice to the browser, which shows an
				// I-beam over editable text: an open card editor or any
				// other editing surface.
				shape = target.closest(EDITABLE_SELECTOR) ? "text" : DEFAULT_CURSOR_SHAPE;
			} else {
				shape = isCursorKeyword(keyword) ? keyword : DEFAULT_CURSOR_SHAPE;
			}
		}
		this.cursorCache.set(target, { buttons: this.lastButtons, dragging, shape });
		return shape;
	}

	/** Class changes arrive in bursts; read the item states once per burst. */
	private queueItems(): void {
		if (this.itemsQueued || this.destroyed) return;
		this.itemsQueued = true;
		queueMicrotask(() => {
			this.itemsQueued = false;
			if (!this.destroyed) this.sampleItems();
		});
	}

	/**
	 * Every node and edge carrying one of Obsidian's state classes, with
	 * live geometry for nodes being dragged or resized. Edges ending in a
	 * drag placeholder belong to the connection channel instead.
	 */
	sampleItems(): void {
		const canvas = this.canvas;
		const dragging = this.isDragging();
		const items: Record<string, CanvasPresenceItem> = {};
		for (const node of canvas.nodes.values()) {
			const classes = stateClassesOf(node.nodeEl);
			if (classes.length === 0) continue;
			const item: CanvasPresenceItem = { classes };
			if (dragging && classes.includes("is-dragging")) {
				item.geometry = {
					x: node.x,
					y: node.y,
					width: node.width,
					height: node.height,
				};
			}
			items[node.id] = item;
		}
		for (const edge of canvas.edges.values()) {
			if (this.hasPlaceholderEnd(edge)) continue;
			const classes = stateClassesOf(edge.lineGroupEl);
			if (classes.length > 0) items[edge.id] = { classes };
		}
		this.publisher.setItems(items);
	}

	sampleConnection(): void {
		if (this.destroyed) return;
		const connecting = this.canvas.canvasEl.classList.contains(CONNECTING_CLASS);
		let edge = this.pendingEdgeId
			? this.canvas.edges.get(this.pendingEdgeId)
			: undefined;
		// Snapped to a target and dropped: the drag is over and the edge is
		// an ordinary one now. While the drag lasts it is still the pending
		// edge even when snapped, and after a drop onto empty space it keeps
		// its placeholder end for as long as the add-card menu is open.
		if (edge && !connecting && !this.hasPlaceholderEnd(edge)) {
			edge = undefined;
		}
		if (!edge) {
			edge = this.findPlaceholderEdge();
			this.pendingEdgeId = edge?.id ?? null;
		}
		this.setConnectionSampling(!!edge);
		this.publisher.setEdge(edge ? this.describeEdge(edge) : null);
	}

	private hasPlaceholderEnd(edge: CanvasEdge): boolean {
		return this.isPlaceholder(edge.from) || this.isPlaceholder(edge.to);
	}

	/**
	 * Obsidian moves the drag's placeholder from a window-level pointer
	 * listener, so the wrapper's events are not a complete record of it;
	 * while a pending edge exists, read it on the cursor cadence.
	 */
	private setConnectionSampling(active: boolean): void {
		if (active && this.connectionTimer === null) {
			this.connectionTimer = this.timeProvider.setInterval(() => {
				if (this.isDragging()) this.publishPointer();
				else this.sampleConnection();
			}, CONNECTION_SAMPLE_MS);
		} else if (!active && this.connectionTimer !== null) {
			this.timeProvider.clearInterval(this.connectionTimer);
			this.connectionTimer = null;
		}
	}

	/** The edge whose end is the placeholder node Obsidian drags with the pointer. */
	private findPlaceholderEdge(): CanvasEdge | undefined {
		for (const edge of this.canvas.edges.values()) {
			if (this.hasPlaceholderEnd(edge)) return edge;
		}
		return undefined;
	}

	private isPlaceholder(end: CanvasEdgeEnd): boolean {
		return !!end.node && !this.canvas.nodes.has(end.node.id);
	}

	private describeEdge(edge: CanvasEdge): CanvasPresenceEdge | null {
		const from = this.describeEnd(edge.from);
		const to = this.describeEnd(edge.to);
		return from && to ? { id: edge.id, from, to } : null;
	}

	private describeEnd(end: CanvasEdgeEnd): CanvasPresenceEdgeEnd | null {
		const node = end.node;
		if (!node) return null;
		if (this.canvas.nodes.has(node.id)) {
			return { node: node.id, side: end.side };
		}
		return roundPoint({ x: node.x, y: node.y });
	}

	destroy(): void {
		this.destroyed = true;
		this.exitFrame();
		if (this.viewportTimer !== null) {
			this.timeProvider.clearTimeout(this.viewportTimer);
			this.viewportTimer = null;
		}
		this.setConnectionSampling(false);
		this.classObserver?.disconnect();
		this.classObserver = null;
		for (const unsubscribe of this.unsubscribes.splice(0)) {
			unsubscribe();
		}
		this.lastTarget = null;
		this.canvas = null as unknown as typeof this.canvas;
		this.publisher = null as unknown as typeof this.publisher;
		this.hooks = {};
	}
}

function stateClassesOf(el: Element): StateClass[] {
	return STATE_CLASSES.filter((name) => el.classList.contains(name));
}
