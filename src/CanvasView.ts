import type { TFile, TextFileView, WorkspaceLeaf } from "obsidian";

export type CanvasSide = "top" | "right" | "bottom" | "left";

/** A point in canvas space: the coordinate system of node x/y values. */
export interface CanvasPoint {
	x: number;
	y: number;
}

export interface CanvasBBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** The wrapper element's screen rect, centered so the viewport center is (0, 0). */
export interface CanvasRect extends CanvasBBox {
	width: number;
	height: number;
	cx: number;
	cy: number;
}

export interface ObsidianCanvas extends TextFileView {
	__proto__: unknown;
	importData(data: CanvasData, noclue: boolean): void;
	requestSave(): void;
	applyHistory(data: unknown): void;
	getData(): CanvasData;
	markMoved(item: CanvasNode | CanvasEdge): void;
	markDirty(item: CanvasNode | CanvasEdge): void;
	addEdge(edge: CanvasEdge): void;
	removeEdge(edge: CanvasEdge): void;
	/** Every edge with either end on the node. */
	getEdgesForNode(node: CanvasNode): CanvasEdge[];
	nodes: Map<string, CanvasNode>;
	edges: Map<string, CanvasEdge>;
	/** The SVG layers edges draw their lines and arrowheads into. */
	edgeContainerEl: SVGSVGElement;
	edgeEndContainerEl: SVGSVGElement;
	/** Animate the viewport to show a canvas-space rectangle with padding. */
	zoomToBbox(bbox: CanvasBBox): void;
	/** The untransformed element that fills the view and receives pointer events. */
	wrapperEl: HTMLElement;
	/**
	 * The pan/zoom-transformed element holding nodes and edges. Children
	 * positioned at canvas-space coordinates land where the nodes do.
	 */
	canvasEl: HTMLElement;
	/** The canvas-space point at the viewport center. */
	x: number;
	y: number;
	/** The zoom exponent; `scale` is 2 ** zoom. */
	zoom: number;
	scale: number;
	/** Set by pan, zoom, and resize; cleared when the viewport animation settles. */
	viewportChanged: boolean;
	/** True for the length of any pointer drag: nodes, edge ends, resizes, marquee. */
	isDragging: boolean;
	setDragging(active: boolean): void;
	/** Undefined until the wrapper has been measured. */
	canvasRect?: CanvasRect;
	selection: Set<CanvasNode | CanvasEdge>;
	posFromEvt(evt: { clientX: number; clientY: number }): CanvasPoint;
	posFromClient(point: { x: number; y: number }): CanvasPoint;
	getViewportBBox(): CanvasBBox;
	markViewportChanged(): void;
	onResize(): void;
	/** The single path every selection change takes. */
	updateSelection(mutate: () => void): void;
}

export interface CanvasView {
	getViewType(): "canvas";
	file?: TFile;
	containerEl: HTMLElement;
	leaf: WorkspaceLeaf;
	data: string;
	canvas: ObsidianCanvas;

	setViewData(data: string, clear: boolean): void;
}

/** The geometry an edge needs from whatever it is anchored to. */
export interface CanvasNodeGeometry {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	getBBox(): CanvasBBox;
}

export interface CanvasNode extends CanvasNodeGeometry {
	/** The node's own text; what getData reports for a text node. */
	text: string;
	/** True while the node's embedded editor is open. */
	isEditing: boolean;
	nodeEl: HTMLElement;
	getData(): CanvasNodeData;
	setText(text: string): void;
}

export type CanvasEdgeEndStyle = "none" | "arrow";

/**
 * One end of an edge. While a connection is being drawn the node is a
 * placeholder that follows the pointer and is absent from the canvas's
 * node map.
 */
export interface CanvasEdgeEnd {
	node: CanvasNodeGeometry;
	side: CanvasSide;
	end?: CanvasEdgeEndStyle;
}

export interface CanvasEdge {
	id: string;
	from: CanvasEdgeEnd;
	to: CanvasEdgeEnd;
	/** A canvas color preset ("1".."6") or a hex color; empty for the theme default. */
	color: string;
	lineGroupEl: SVGGElement;
	lineEndGroupEl: SVGGElement;
	getData(): CanvasEdgeData;
	/** Put the line and arrowhead groups into the canvas's edge layers. */
	attach(): void;
	detach(): void;
	destroy(): void;
	/** Recompute the path from both ends' current geometry and apply the color. */
	render(): void;
	setColor(color: string, render?: boolean): void;
}

/**
 * Obsidian's edge class is reachable only through an instance's
 * constructor; a presence overlay borrows it to draw peers' connections
 * with Obsidian's own path, arrowhead, and color handling.
 */
export type CanvasEdgeConstructor = new (
	canvas: ObsidianCanvas,
	id: string,
	from: CanvasEdgeEnd,
	to: CanvasEdgeEnd,
) => CanvasEdge;

export function isCanvasEdge(item: CanvasNode | CanvasEdge): item is CanvasEdge {
	return "from" in item && "to" in item;
}

export interface CanvasData {
	nodes: CanvasNodeData[];
	edges: CanvasEdgeData[];
}

export interface CanvasNodeData {
	id: string;
	type: string;
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	file?: TFile;
	child?: TextFileView;
}

export interface CanvasEdgeData {
	id: string;
	fromNode: string;
	fromSide: string;
	toNode: string;
	toSide: string;
}
