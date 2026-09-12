/**
 * Canvas presence: cursors, viewports, selections, and in-progress
 * connections shared between viewers of the same canvas through yjs
 * awareness. One CanvasPresencePlugin per attached canvas view.
 */

export { CanvasPresencePlugin } from "./CanvasPresencePlugin";
export type { CanvasPresencePluginOptions } from "./CanvasPresencePlugin";
export {
	CanvasPresencePublisher,
	CURSOR_INTERVAL_MS,
	INBOUND_CURSOR_BUDGET_PER_S,
	SELECTION_INTERVAL_MS,
	VIEWPORT_INTERVAL_MS,
	cursorIntervalFor,
} from "./CanvasPresencePublisher";
export {
	CANVAS_PRESENCE_FIELD,
	CANVAS_PRESENCE_VERSION,
	emptyCanvasPresence,
	readCanvasPresence,
	readCanvasPresenceUser,
} from "./types";
export type {
	CanvasPresenceEdge,
	CanvasPresenceEdgeEnd,
	CanvasPresenceInteraction,
	CanvasPresencePointer,
	CanvasPresenceTarget,
	CanvasPresenceState,
	CanvasPresenceUser,
	CanvasPresenceViewport,
} from "./types";
