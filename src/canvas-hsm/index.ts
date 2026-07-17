/**
 * CanvasHSM — the per-canvas content-convergence engine.
 *
 * Public surface: the machine (CanvasHSM + CANVAS_MACHINE), the
 * localDoc/remoteDoc bridge, and the type family. Hosts construct one
 * CanvasHSM and one CanvasDocBridge per canvas and execute the machine's
 * effects through the existing sync machinery.
 */

export { CanvasHSM } from "./CanvasHSM";
export { CANVAS_MACHINE } from "./machine-definition";
export {
	CanvasDocBridge,
	CANVAS_BRIDGE_IN_ORIGIN,
	CANVAS_BRIDGE_OUT_ORIGIN,
} from "./bridge";
export type {
	CanvasCapabilities,
	CanvasContext,
	CanvasDiskMeta,
	CanvasEffect,
	CanvasEvent,
	CanvasHSMConfig,
	CanvasLCA,
	CanvasMachineDefinition,
	CanvasStateNode,
	CanvasStatePath,
	EvaluationResult,
	EvaluationVerdict,
} from "./types";
