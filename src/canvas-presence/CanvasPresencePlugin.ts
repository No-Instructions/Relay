import type { Awareness } from "y-protocols/awareness";
import type { Canvas } from "../Canvas";
import type { CanvasView } from "../CanvasView";
import { HasLogging } from "../debug";
import { trackPromise } from "../trackPromise";
import { CanvasPresenceInput } from "./CanvasPresenceInput";
import {
	CanvasPresenceOverlay,
	adoptEdgeConstructor,
} from "./CanvasPresenceOverlay";
import {
	CanvasPresencePublisher,
	cursorIntervalFor,
} from "./CanvasPresencePublisher";
import {
	CANVAS_PRESENCE_FIELD,
	type CanvasPresenceState,
	type CanvasPresenceUser,
} from "./types";

export interface CanvasPresencePluginOptions {
	resolveName: (user: CanvasPresenceUser | undefined) => string;
}

type AwarenessUpdate = { added: number[]; updated: number[]; removed: number[] };

/**
 * Wires one canvas view to presence: the input reads the local viewer off
 * Obsidian's canvas into the publisher, the publisher writes the awareness
 * field, and the overlay renders every other viewer of the same canvas.
 */
export class CanvasPresencePlugin extends HasLogging {
	private publisher: CanvasPresencePublisher;
	private input: CanvasPresenceInput | null = null;
	private overlay: CanvasPresenceOverlay | null = null;
	private awareness: Awareness | null = null;
	private offAwarenessUpdate: (() => void) | null = null;
	private offProviderState: (() => void) | null = null;
	private destroyed = false;

	constructor(
		view: CanvasView,
		private relayCanvas: Canvas,
		options: CanvasPresencePluginOptions,
	) {
		super();
		this.setLoggers(`[CanvasPresence](${relayCanvas.path})`);
		const timeProvider = relayCanvas.timeProvider;
		this.publisher = new CanvasPresencePublisher({
			timeProvider,
			sink: (state) => this.publish(state),
		});
		this.overlay = new CanvasPresenceOverlay(view.canvas, {
			timeProvider,
			resolveName: options.resolveName,
			// Every viewer paces its own sending by how many others are
			// active, so each viewer's inbound cursor traffic stays bounded.
			onActivePeers: (count) =>
				this.publisher.setCursorInterval(cursorIntervalFor(count)),
		});
		this.input = new CanvasPresenceInput(view.canvas, this.publisher, timeProvider, {
			onViewportChanging: () => this.overlay?.trackViewport(),
			onItemMoved: () => this.overlay?.refreshGeometry(),
			onEdgeAdded: (edge) => adoptEdgeConstructor(edge),
		});
		// The provider, and with it the awareness instance, can be created or
		// rebuilt after this view attached; every connection-state change is
		// a chance to notice.
		this.offProviderState = relayCanvas.subscribe(this, () => this.bindAwareness());
		this.bindAwareness();
		void trackPromise(
			`canvasPresence:whenReady:${relayCanvas.guid}`,
			relayCanvas.whenReady(),
		)
			.then(() => {
				if (!this.destroyed) this.bindAwareness();
			})
			.catch((error) => {
				if (!this.destroyed) this.debug("canvas not ready for presence", error);
			});
	}

	private bindAwareness(): void {
		if (this.destroyed) return;
		const awareness = this.relayCanvas._provider?.awareness ?? null;
		if (awareness === this.awareness) return;
		this.offAwarenessUpdate?.();
		this.offAwarenessUpdate = null;
		this.awareness = awareness;
		this.overlay?.bind(awareness);
		if (!awareness) return;
		// Taking the lock, or a profile refresh, resets the local state to
		// the bare profile and drops the presence field; put it back.
		const onUpdate = ({ added, updated }: AwarenessUpdate) => {
			const local = awareness.clientID;
			if (!added.includes(local) && !updated.includes(local)) return;
			const state = awareness.getLocalState();
			if (state && !(CANVAS_PRESENCE_FIELD in state)) {
				this.publisher.republish();
			}
		};
		awareness.on("update", onUpdate);
		this.offAwarenessUpdate = () => awareness.off("update", onUpdate);
		this.publisher.republish();
	}

	/** Bring this view to where a peer is looking; false when the peer has no viewport. */
	locateUser(userId: string): boolean {
		return this.overlay?.locateUser(userId) ?? false;
	}

	private publish(state: CanvasPresenceState): void {
		const awareness = this.awareness;
		// No local state means the lock is not held: presence stays silent.
		if (!awareness || awareness.getLocalState() === null) return;
		try {
			awareness.setLocalStateField(CANVAS_PRESENCE_FIELD, state);
		} catch (error) {
			this.warn("presence publish failed", error);
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.input?.destroy();
		this.input = null;
		this.publisher.destroy();
		this.offProviderState?.();
		this.offProviderState = null;
		this.offAwarenessUpdate?.();
		this.offAwarenessUpdate = null;
		const awareness = this.awareness;
		if (awareness && awareness.getLocalState() !== null) {
			// Withdraw the field so peers drop this viewer at once instead of
			// when the lock is released.
			try {
				awareness.setLocalStateField(CANVAS_PRESENCE_FIELD, null);
			} catch (error) {
				this.warn("presence withdrawal failed", error);
			}
		}
		this.overlay?.destroy();
		this.overlay = null;
		this.awareness = null;
		this.relayCanvas = null as unknown as typeof this.relayCanvas;
	}
}
