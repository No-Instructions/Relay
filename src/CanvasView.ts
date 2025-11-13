import type { TFile, TextFileView, WorkspaceLeaf } from "obsidian";

export interface ObsidianCanvas extends TextFileView {
	__proto__: any;
	importData(data: CanvasData, noclue: boolean): void;
	requestSave(): void;
	applyHistory(data: any): void;
	getData(): CanvasData;
	markMoved(item: CanvasNode | CanvasEdge): void;
	markDirty(item: CanvasNode | CanvasEdge): void;
	nodes: Map<string, CanvasNode>;
	edges: Map<string, CanvasEdge>;
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

export interface CanvasNode {
	id: string;
	getData(): CanvasNodeData;
	setText(text: string): void;
}

export interface CanvasEdge {
	id: string;
	getData(): CanvasEdgeData;
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
