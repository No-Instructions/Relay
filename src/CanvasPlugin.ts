import { around } from "monkey-around";
import { Canvas } from "src/Canvas";
import type {
	CanvasEdge,
	CanvasEdgeData,
	CanvasNode,
	CanvasNodeData,
	CanvasView,
	ObsidianCanvas,
} from "src/CanvasView";
import { LiveViewManager, type RelayCanvasView } from "src/LiveViews";
import { HasLogging } from "src/debug";

import * as Y from "yjs";
import { PreviewPlugin } from "./PreviewPlugin";

export class CanvasPlugin extends HasLogging {
	view: CanvasView;
	relayCanvas: Canvas;
	canvas: ObsidianCanvas;
	unsubscribes: Array<() => void>;
	relayCanvasView: RelayCanvasView;
	observedTextNodes: Set<string>;

	constructor(
		private connectionManager: LiveViewManager,
		relayCanvasView: RelayCanvasView,
	) {
		super();
		this.view = relayCanvasView.view;
		this.canvas = relayCanvasView.view.canvas;
		this.relayCanvas = relayCanvasView.canvas;
		this.unsubscribes = [];
		this.relayCanvasView = relayCanvasView;
		this.observedTextNodes = new Set();
		this.install();

		for (const node of this.getEmbedViews()) {
			console.warn("node", node);
			if (!node.file) {
				continue;
			}
			this.unsubscribes.push(
				(() => {
					console.warn(node);
					const plugin = new PreviewPlugin(
						node,
						this.relayCanvas.sharedFolder.proxy.getDoc(node.file.path),
					);
					return () => {
						plugin.destroy();
					};
				})(),
			);
		}
	}

	destroy() {
		if (this.canvas) {
			this.unsubscribes.forEach((unsubscribe) => unsubscribe());
			this.unsubscribes = [];
		}
		this.relayCanvasView.tracking = false;
		this.canvas = null as any;
		this.relayCanvas = null as any;
		this.relayCanvasView = null as any;
		this.unsubscribes.length = 0;
	}

	observeNode(node: CanvasNodeData) {
		if (this.observedTextNodes.has(node.id)) return;
		if (node.type === "text") {
			console.warn("observing text node");
			const ytext = this.relayCanvas.textNode(node);
			const nodeId = node.id;
			const _textObserver = (event: Y.YTextEvent) => {
				const node = this.canvas.nodes.get(nodeId);
				if (node) {
					node.setText(ytext.toString());
					this.canvas.markDirty(node);
				}
			};
			ytext.observe(_textObserver);
			this.unsubscribes.push(() => {
				this.relayCanvas.textNode(node).unobserve(_textObserver);
				this.observedTextNodes.delete(nodeId);
			});
		}
	}

	public getEmbedViews() {
		return [...this.canvas.nodes.values()].map((nodeData) => {
			//@ts-ignore
			return nodeData.child;
		});
	}

	public markDirty(node: CanvasNodeData) {
		const fullNode = this.canvas.nodes.get(node.id);
		if (fullNode) {
			this.canvas.markDirty(fullNode);
		}
	}

	private install() {
		if (!this.canvas) return;

		this.debug(
			"connecting canvas view to canvas",
			this.view.file?.path,
			this.relayCanvas.path,
		);

		// eslint-disable-next-line
		const that = this;
		const exported = Canvas.exportCanvasData(this.relayCanvas.ydoc);
		const hasCanvasData =
			exported.nodes.length > 0 || exported.edges.length > 0;
		const hasLocalDB = this.relayCanvas.hasLocalDB();

		if (hasLocalDB && hasCanvasData) {
			this.canvas.importData(exported, true);
		}

		this.unsubscribes.push(
			around(this.canvas, {
				requestSave(old: any) {
					return function () {
						// @ts-ignore
						const res = old.call(this);
						try {
							that.relayCanvas.importFromView(that.view);
						} catch (e) {
							that.log(e);
						}
						return res;
					};
				},
				applyHistory(old: any) {
					return function (data: any) {
						// @ts-ignore
						const res = old.call(this, data);
						try {
							that.relayCanvas.importFromView(that.view);
						} catch (e) {
							that.log(e);
						}
						return res;
					};
				},
			}),
		);

		const _observer = <T extends CanvasNodeData | CanvasEdgeData>(
			event: Y.YMapEvent<T>,
			store: Map<string, CanvasNode> | Map<string, CanvasEdge>,
		) => {
			let log = "";
			log += `Transaction origin: ${event.transaction.origin} ${event.transaction.origin?.constructor?.name}\n`;
			if (!this.relayCanvas) {
				this.log("relay canvas is already destroyed");
			}

			if (!this.canvas) {
				this.log("canvas is already destroyed");
				return;
			}
			if (!this.view.file?.path.endsWith(this.relayCanvas.path)) {
				this.log("event is for another node");
				return;
			}
			if (event.transaction.origin === this.relayCanvas) {
				return;
			}
			const exported = Canvas.exportCanvasData(this.relayCanvas.ydoc);
			for (const [key, delta] of event.changes.keys) {
				log += `key: ${key} action: ${delta.action}\n\n`;
			}

			this.debug(log);
			this.debug(
				"importing data",
				this.view.file?.path,
				this.relayCanvas.path,
				exported,
			);
			this.canvas.importData(exported, true);
			this.canvas.requestSave();
			for (const key of event.keysChanged) {
				const node = store.get(key);
				if (node) {
					if (this.canvas.nodes.has(node.id)) {
						this.observeNode((node as CanvasNode).getData());
					}
					this.canvas.markMoved(node);
					this.canvas.markDirty(node);
				}
			}
		};

		const _nodeObserver = (event: Y.YMapEvent<CanvasNodeData>) => {
			return _observer<CanvasNodeData>(event, this.canvas.nodes);
		};
		this.relayCanvas.ynodes.observe(_nodeObserver);
		this.unsubscribes.push(() => {
			this.relayCanvas.ynodes.unobserve(_nodeObserver);
		});

		for (const [, node] of this.relayCanvas.ynodes) {
			this.observeNode(node);
		}

		const _edgeObserver = (event: Y.YMapEvent<CanvasEdgeData>) => {
			return _observer<CanvasEdgeData>(event, this.canvas.edges);
		};
		this.relayCanvas.yedges.observe(_edgeObserver);
		this.unsubscribes.push(() => {
			this.relayCanvas.yedges.unobserve(_edgeObserver);
		});

		this.relayCanvasView.tracking = true;
	}
}
