import { getPatcher } from "./Patcher";
import { Canvas } from "src/Canvas";
import type {
	CanvasEdge,
	CanvasEdgeData,
	CanvasNode,
	CanvasNodeData,
	CanvasView,
	ObsidianCanvas,
} from "src/CanvasView";
import type {
	RelayCanvasView,
	DocumentViewer,
	LiveViewManager,
} from "src/LiveViews";
import { HasLogging } from "src/debug";

import * as Y from "yjs";
import { ViewHookPlugin } from "./plugins/ViewHookPlugin";
import { flags } from "./flagManager";
import type { EditorViewRef } from "./merge-hsm/types";
import { HSMEditorPlugin } from "./merge-hsm/integration/HSMEditorPlugin";
import type { Document } from "./Document";

export class CanvasPlugin extends HasLogging {
	view: CanvasView;
	relayCanvas: Canvas;
	canvas: ObsidianCanvas;
	unsubscribes: Array<() => void>;
	relayCanvasView: RelayCanvasView;
	observedTextNodes: Set<string>;
	trackedEmbedViews: Set<any>;

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
		this.trackedEmbedViews = new Set();
		this.install();

		// Enable embedded view synchronization if enableLiveEmbeds is true
		if (flags().enableLiveEmbeds) {
			for (const node of this.getEmbedViews()) {
				if (!node.file) {
					continue;
				}
				this.connectEmbedView(node);
			}
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
		return [...this.canvas.nodes.values()]
			.map((nodeData) => {
				//@ts-ignore
				return nodeData.child;
			})
			.filter((x) => !!x);
	}

	public markDirty(node: CanvasNodeData) {
		const fullNode = this.canvas.nodes.get(node.id);
		if (fullNode) {
			this.canvas.markDirty(fullNode);
		}
	}

	private isEmbedAlreadyTracked(embedView: any): boolean {
		return this.trackedEmbedViews.has(embedView);
	}

	private createEmbedEditorViewRef(embedView: any): EditorViewRef {
		return {
			getViewData() {
				if (typeof embedView?.getViewData === "function") {
					return embedView.getViewData();
				}

				const cmDoc = embedView?.editor?.cm?.state?.doc;
				if (typeof cmDoc?.toString === "function") {
					return cmDoc.toString();
				}

				if (typeof embedView?.text === "string") {
					return embedView.text;
				}

				if (typeof embedView?.data === "string") {
					return embedView.data;
				}

				if (typeof embedView?.lastSavedData === "string") {
					return embedView.lastSavedData;
				}

				return "";
			},
		};
	}

	private syncEmbedViewToDocument(
		document: Document,
		viewRef: EditorViewRef,
		reason: string,
	): boolean {
		try {
			if (!document.isWritable) {
				return false;
			}

			const contents = viewRef.getViewData();
			if (document.localText === contents) {
				return false;
			}

			const hsm = document.hsm;
			if (!hsm) {
				return false;
			}

			const changes = hsm.computeDiffChanges(document.localText, contents);
			this.debug(
				"syncing canvas embed view to HSM",
				document.path,
				reason,
			);
			hsm.send({
				type: "CM6_CHANGE",
				changes,
				docText: contents,
				userEvent: "set",
			});
			return true;
		} catch (error: unknown) {
			this.error(
				`Error syncing canvas embed during ${reason}:`,
				error,
			);
			return false;
		}
	}

	private connectEmbedView(embedView: any): void {
		if (!embedView.file) {
			return;
		}

		// Only markdown embeds have CM6 editors that need ViewHookPlugin + HSM.
		// Canvas embeds render as canvas views, and media (images, SVG, PDF)
		// are SyncFiles — neither uses a text editor.
		const path: string = embedView.file.path;
		if (!path.endsWith(".md")) {
			return;
		}

		this.trackedEmbedViews.add(embedView);
		this.unsubscribes.push(
			(() => {
				const document = this.relayCanvas.sharedFolder.proxy.getDoc(embedView.file.path);
				const viewRef = this.createEmbedEditorViewRef(embedView);
				const syncEmbedViewToDocument = this.syncEmbedViewToDocument.bind(this);
				const logError = this.error.bind(this);
				const plugin = new ViewHookPlugin(
					embedView,
					document,
				);
				const requestSaveUnsubscribe = getPatcher().patch(embedView, {
					requestSave: (old: any) => {
						return function (this: any) {
							const result = old.call(this);
							this?.app?.metadataCache?.trigger?.("resolve", this.file);
							// Canvas embeds do not run through TextViewPlugin, so
							// preview/frontmatter edits need an explicit requestSave
							// bridge back into the active HSM document.
							document.whenReady().then(() => {
								if (!cancelled && !document.destroyed) {
									// `requestSave()` fires after preview metadata commits
									// (Enter/blur) and mirrors the regular editor path.
									// Sync the embed buffer to localDoc before Relay's
									// debounced save writes the file to disk.
									const changed = syncEmbedViewToDocument(
										document,
										viewRef,
										"requestSave",
									);
									if (changed) {
										document.requestSave();
									}
								}
							}).catch((error: unknown) => {
								logError(
									"Error waiting for canvas embed document readiness during requestSave:",
									error,
								);
							});
							return result;
						};
					},
				});
				const viewer: DocumentViewer =
					embedView.leaf ?? Symbol(`canvas-embed:${embedView.file.path}`);
				let cancelled = false;
				let lockAcquired = false;

				document
					.whenReady()
					.then(() => {
						if (cancelled) {
							return;
						}

						try {
							const initialContents = viewRef.getViewData();
							if (!document.hsm?.isActive() && initialContents.length > 0) {
								// Canvas embeds do not reliably pass through the normal
								// TextFileView load hooks before ACQUIRE_LOCK. Seed the
								// HSM with the current embed buffer so active entry does
								// not reconcile against an empty localDoc.
								document.hsm?.send({
									type: "OBSIDIAN_SET_VIEW_DATA",
									data: initialContents,
									clear: true,
								});
							}
							this.connectionManager.acquireDocumentLock(
								document,
								viewRef,
								viewer,
							);
							lockAcquired = true;
						} catch (error: unknown) {
							this.error(
								"Error acquiring lock for canvas embed:",
								error,
							);
							return;
						}

						const cm = (embedView.editor as any)?.cm;
						const hsmEditorPlugin = cm?.plugin?.(HSMEditorPlugin);
						hsmEditorPlugin?.initializeIfReady();

						plugin.initialize().catch((error) => {
							this.error(
								"Error initializing ViewHookPlugin for canvas embed:",
								error,
							);
						});
					})
					.catch((error: unknown) => {
						this.error(
							"Error waiting for canvas embed readiness:",
							error,
						);
					});

				return () => {
					cancelled = true;
					this.trackedEmbedViews.delete(embedView);
					requestSaveUnsubscribe();
					plugin.destroy();
					if (lockAcquired) {
						this.connectionManager.releaseDocumentLock(
							document,
							viewer,
						);
					}
				};
			})(),
		);
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
			getPatcher().patch(this.canvas, {
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
						
						// Check if this is a newly created embed node that needs ViewHookPlugin
						if (flags().enableLiveEmbeds) {
							//@ts-ignore
							const embedView = node.child;
							if (embedView?.file && !this.isEmbedAlreadyTracked(embedView)) {
								this.connectEmbedView(embedView);
							}
						}
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
