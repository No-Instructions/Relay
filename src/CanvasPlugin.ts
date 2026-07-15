import { getPatcher } from "./Patcher";
import { Canvas } from "src/Canvas";
import { areCanvasDataEqual, mergeCanvasViewData } from "./CanvasData";
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
	/**
	 * True once the view's rendered data is known to belong to view.file.
	 * Obsidian reuses canvas views across file switches: between the file
	 * pointer moving and setViewData landing, the view still renders the
	 * previous file's nodes, and merging those into this canvas would
	 * splice two canvases together. Until ownership is established, no
	 * content crosses between the view and the localDoc in either
	 * direction. Ownership is granted by setViewData (a load for
	 * view.file), by a native save (which writes the rendered data into
	 * view.file by definition), or by the construction-time disk
	 * comparison for views that were already settled.
	 */
	private viewDataOwned = false;

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
		this.verifyViewDataOwnership();
	}

	/**
	 * Establish ownership by comparing the view's rendered data against
	 * the file's contents on disk. A mismatch means a load is in flight
	 * (or the view holds unsaved edits); ownership then arrives with the
	 * next setViewData or native save instead.
	 */
	private async verifyViewDataOwnership(): Promise<void> {
		const file = this.view?.file;
		if (!file || this.viewDataOwned) return;
		try {
			const raw = await this.relayCanvas.vault.cachedRead(file);
			if (!this.canvas || !this.relayCanvas) return;
			if (this.view.file !== file) return;
			const parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
			const diskData = {
				nodes: parsed.nodes ?? [],
				edges: parsed.edges ?? [],
			};
			if (areCanvasDataEqual(diskData, this.canvas.getData())) {
				this.markViewDataOwned();
			}
		} catch (e) {
			this.debug("view data ownership deferred to next load", e);
		}
	}

	private markViewDataOwned(): void {
		if (this.viewDataOwned || !this.relayCanvas) return;
		this.viewDataOwned = true;
		for (const node of this.getEmbedViews()) {
			if (!node.file) {
				continue;
			}
			this.connectEmbedView(node);
		}
		// Content that reached the localDoc before ownership was
		// established produced no view updates; ask the machine for a
		// reconcile now that the view may be written.
		this.relayCanvas.hsm.send({ type: "OBSIDIAN_SET_VIEW_DATA" });
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

	private requestNativeEmbedSave(
		embedView: any,
		state: { saving: boolean },
	): void {
		state.saving = true;
		try {
			embedView.requestSave();
		} finally {
			state.saving = false;
		}
	}

	private syncDocumentToEmbedView(
		document: Document,
		embedView: any,
		viewRef: EditorViewRef,
		state: { saving: boolean; tracking: boolean },
		reason: string,
	): boolean {
		if (typeof embedView?.setViewData !== "function") {
			return false;
		}

		const contents = document.localText;
		if (viewRef.getViewData() === contents) {
			state.tracking = true;
			return false;
		}

		this.debug("syncing canvas embed HSM to view", document.path, reason);
		state.saving = true;
		try {
			embedView.setViewData(contents, false);
		} finally {
			state.saving = false;
		}
		this.requestNativeEmbedSave(embedView, state);
		state.tracking = true;
		return true;
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
				const syncDocumentToEmbedView = this.syncDocumentToEmbedView.bind(this);
				const logError = this.error.bind(this);
				const plugin = new ViewHookPlugin(
					embedView,
					document,
				);
				const state = { saving: false, tracking: false };
				let observedYText: Y.Text | null = null;
				let ytextObserver:
					| ((event: Y.YTextEvent, tr: Y.Transaction) => void)
					| null = null;
				const requestSaveUnsubscribe = getPatcher().patch(embedView, {
					requestSave: (old: any) => {
						return function (this: any) {
							if (!state.saving && !this?.__relaySaving) {
								try {
									syncEmbedViewToDocument(
										document,
										viewRef,
										"requestSave",
									);
									state.tracking = true;
								} catch (error: unknown) {
									logError(
										"Error syncing canvas embed during requestSave:",
										error,
									);
								}
							}
							this?.app?.metadataCache?.trigger?.("resolve", this.file);
							return old.call(this);
						};
					},
				});
				const viewer: DocumentViewer =
					embedView.leaf ?? Symbol(`canvas-embed:${embedView.file.path}`);
				let cancelled = false;
				let lockAcquired = false;

				document
					.whenReady()
					.then(async () => {
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

						const hsm = document.hsm;
						if (hsm?.awaitState) {
							await hsm.awaitState((state) => state.startsWith("active."));
							if (cancelled) {
								return;
							}
						}

						const localDoc = document.localDoc;
						if (localDoc) {
							observedYText = localDoc.getText("contents");
							ytextObserver = (_event: Y.YTextEvent, tr: Y.Transaction) => {
								if (cancelled || document.destroyed) {
									return;
								}
								if (tr.origin === document || tr.origin === document.hsm) {
									return;
								}
								syncDocumentToEmbedView(
									document,
									embedView,
									viewRef,
									state,
									"localDoc.observe",
								);
							};
							observedYText.observe(ytextObserver);
						}

						syncDocumentToEmbedView(
							document,
							embedView,
							viewRef,
							state,
							"initial-sync",
						);

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
					if (observedYText && ytextObserver) {
						observedYText.unobserve(ytextObserver);
					}
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

	/**
	 * Bring the view in line with the canvas localDoc. Content that reached
	 * the localDoc before this view opened produces no observer events, so
	 * a view loaded from a stale disk file would otherwise render stale
	 * forever — and its first save would push that stale state back into
	 * the localDoc, deleting newer peer content via applyData's diff.
	 * View-only nodes and edges are kept: they are local edits that have
	 * not been pushed yet.
	 *
	 * Runs as the machine's RECONCILE_VIEW executor: the CanvasHSM emits
	 * the effect on view attach and after every OBSIDIAN_SET_VIEW_DATA, and only
	 * from its active state.
	 */
	private reconcileViewWithCanvas() {
		if (!this.canvas || !this.relayCanvas) return;
		// Obsidian reuses canvas views across file switches; a stale effect
		// firing for another file must not merge two canvases together. The
		// TFile identity check rejects aliases (two folders can hold
		// canvases at the same relative path), and ownership rejects a
		// reused view that has not finished loading this file's data.
		if (!this.view.file || this.view.file !== this.relayCanvas.tfile) return;
		if (!this.viewDataOwned) return;
		const merged = mergeCanvasViewData(
			this.relayCanvas.exportData(),
			this.canvas.getData(),
		);
		if (!merged) return;
		this.debug(
			"reconciling view with canvas localDoc",
			this.view.file?.path,
			merged,
		);
		this.canvas.importData(merged, true);
		this.canvas.requestSave();
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

		const reconciler = () => this.reconcileViewWithCanvas();
		this.relayCanvas.setViewReconciler(reconciler);
		this.unsubscribes.push(() => {
			this.relayCanvas.clearViewReconciler(reconciler);
		});

		this.unsubscribes.push(
			getPatcher().patch(this.view, {
				setViewData(old: any) {
					return function (data: string, clear: boolean) {
						// @ts-ignore
						const res = old.call(this, data, clear);
						// A load delivers view.file's own data, so it grants
						// ownership. The file load lands after install, so a
						// stale disk file would overwrite anything imported
						// earlier; the machine re-reconciles after every load.
						try {
							that.markViewDataOwned();
							that.relayCanvas.hsm.send({ type: "OBSIDIAN_SET_VIEW_DATA" });
						} catch (e) {
							that.log(e);
						}
						return res;
					};
				},
			}),
		);

		this.unsubscribes.push(
			getPatcher().patch(this.canvas, {
				requestSave(old: any) {
					return function () {
						// @ts-ignore
						const res = old.call(this);
						try {
							// A native save writes the rendered data into
							// view.file, which makes that data the file's by
							// definition — this is what re-establishes
							// ownership for a view that held unsaved edits
							// when the plugin attached.
							that.markViewDataOwned();
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
							if (that.viewDataOwned) {
								that.relayCanvas.importFromView(that.view);
							}
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
			if (!this.view.file || this.view.file !== this.relayCanvas.tfile) {
				this.log("event is for another file");
				return;
			}
			if (!this.viewDataOwned) {
				this.log("view has not loaded this file's data yet");
				return;
			}
			if (event.transaction.origin === this.relayCanvas) {
				return;
			}
			const exported = this.relayCanvas.exportData();
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
						//@ts-ignore
						const embedView = node.child;
						if (embedView?.file && !this.isEmbedAlreadyTracked(embedView)) {
							this.connectEmbedView(embedView);
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

		// The install-time reconcile (content that arrived before this view
		// opened produced no observer events) is requested by
		// markViewDataOwned once the rendered data provably belongs to
		// view.file — never against a reused view that still renders the
		// previous file.

		this.relayCanvasView.tracking = true;
	}
}
