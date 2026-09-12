import type { CanvasPoint } from "../CanvasView";
import type { CanvasPresenceViewport } from "./types";

export function roundPoint(point: CanvasPoint): CanvasPoint {
	return { x: Math.round(point.x), y: Math.round(point.y) };
}

/** Integer bounds and a two-decimal zoom, so sub-pixel motion is not a change. */
export function roundViewport(
	viewport: CanvasPresenceViewport,
): CanvasPresenceViewport {
	return {
		minX: Math.round(viewport.minX),
		minY: Math.round(viewport.minY),
		maxX: Math.round(viewport.maxX),
		maxY: Math.round(viewport.maxY),
		zoom: Math.round(viewport.zoom * 100) / 100,
	};
}

export function pointsEqual(a: CanvasPoint | null, b: CanvasPoint | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.x === b.x && a.y === b.y;
}

export function viewportsEqual(
	a: CanvasPresenceViewport | null,
	b: CanvasPresenceViewport | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.minX === b.minX &&
		a.minY === b.minY &&
		a.maxX === b.maxX &&
		a.maxY === b.maxY &&
		a.zoom === b.zoom
	);
}
