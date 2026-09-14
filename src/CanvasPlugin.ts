import type { MarkdownView, TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { getPatcher } from "./Patcher";
import { Canvas } from "src/Canvas";
import {
	areCanvasDataEqual,
	mergeCanvasThreeWay,
	mergeCanvasViewData,
	foreignViewItems,
	viewDataBelongsToFile,
} from "./CanvasData";
import type {
	CanvasData,
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
import { HasLogging, isDebugging } from "src/debug";

import * as Y from "yjs";
import { ViewHookPlugin } from "./plugins/ViewHookPlugin";
import type { EditorViewRef } from "./merge-hsm/types";
import { HSMEditorPlugin } from "./merge-hsm/integration/HSMEditorPlugin";
import { isDocument, type Document } from "./Document";

/**
 * The embedded editor surface the canvas plugin reads. Markdown embeds
 * inside canvas nodes are sub-views Obsidian does not type.
 */
interface EmbedEditorView {
	file?: TFile | null;
	getViewData?: () => string;
	setViewData?: (data: string, clear: boolean) => void;
	requestSave?: () => void;
	editor?: { cm?: EditorView };
	text?: unknown;
	data?: unknown;
	lastSavedData?: unknown;
}

/**
 * A view node as Obsidian renders it: a file node creates its embed child
 * inside render(), on the frame after a load or when panning first brings
 * the node into the viewport.
 */
type RenderedCanvasNode = CanvasNode & {
	child?: EmbedEditorView;
	render?: () => void;
};

export class CanvasPlugin extends HasLogging {
	view: CanvasView;
	relayCanvas: Canvas;
	canvas: ObsidianCanvas;
	unsubscribes: Array<() => void>;
	relayCanvasView: RelayCanvasView;
	observedTextNodes: Set<string>;
	/**
	 * Embedded editors wired to their documents (lock, live session,
	 * presence), keyed by the embed view Obsidian rendered, with the
	 * release that undoes the wiring.
	 */
	private embedReleases = new Map<EmbedEditorView, () => void>();
	/** The embed each view node currently has wired, for replacement. */
	private nodeEmbeds = new Map<CanvasNode, EmbedEditorView>();
	/** Per view node, the unpatch for its render hook. */
	private nodeHooks = new Map<CanvasNode, () => void>();
	/**
	 * True once the view's rendered data is known to belong to view.file.
	 * Obsidian reuses canvas views across file switches: between the file
	 * pointer moving and setViewData landing, the view still renders the
	 * previous file's nodes, and merging those into this canvas would
	 * splice two canvases together. Until ownership is established, no
	 * content crosses between the view and the localDoc in either
	 * direction. Ownership is granted by setViewData (a load for
	 * view.file), by a native save (which writes the rendered data into
	 * view.file by definition), or by evidence that the rendered nodes are
	 * this file's (viewDataBelongsToFile: each rendered node equals the
	 * file's own node of that id, locally or on disk) — checked at
	 * construction, for a view whose load ran before the plugin attached,
	 * and again whenever the machine settles into a reconcile while the
	 * view is still unowned.
	 */
	private viewDataOwned = false;
	/** The evidence check in flight, so concurrent requests coalesce. */
	private ownershipCheck: Promise<void> | null = null;
	/** A check was requested while one was running; run once more after. */
	private ownershipCheckQueued = false;
	/**
	 * Rendered node and edge ids the last evidence check could match to
	 * neither the local CRDT nor the disk copy; cleared once ownership is
	 * established by any route.
	 */
	private ownershipMismatches: string[] = [];
	/**
	 * Monotonic count of setViewData deliveries; keys a pending ingest to
	 * the exact load that armed it.
	 */
	private loadSeq = 0;
	/**
	 * Set when Obsidian ingests an external disk change into an owned view
	 * (loadFileInternal → setData → setViewData with clear=false; a file
	 * open always clears). Obsidian's ingest is authoritative — an
	 * id-preserving destructive import of the disk state — so the next
	 * reconcile flows view→localDoc instead of overwriting the view with
	 * the CRDT copy.
	 *
	 * Never a bare boolean: the record is keyed to the load (seq) and file
	 * it describes, and is voided by any clearing load (a file open), by
	 * any later load, by a file switch, and by destroy. A stale ingest
	 * flag consumed after an ordinary file open would push the just-loaded
	 * disk state into the localDoc destructively — deleting newer peer
	 * content, replicated — which is exactly the stale-disk overwrite this
	 * plugin exists to prevent.
	 */
	private pendingViewIngest: { seq: number; file: TFile } | null = null;
	/** True while a deferred save for directly assigned card text is pending. */
	private adoptionSaveQueued = false;

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
		this.installReadOnly();
		this.verifyViewDataOwnership();
	}

	private installReadOnly(): void {
		const canvas = this.canvas;
		if (typeof canvas.setReadonly !== "function") return;
		let forced = false;
		let previous = canvas.readonly;
		const owner = () => this;
		const refresh = () => {
			if (!this.relayCanvas.canPublishContent) {
				if (!forced) previous = canvas.readonly;
				forced = true;
				canvas.setReadonly(true);
			} else if (forced) {
				forced = false;
				canvas.setReadonly(previous);
			}
		};
		this.unsubscribes.push(
			getPatcher().patch(canvas, {
				setReadonly(old: (readOnly: boolean) => void) {
					return function (this: ObsidianCanvas, readOnly: boolean) {
						old.call(this, readOnly || !owner().relayCanvas.canPublishContent);
					};
				},
			}),
			this.relayCanvas.subscribe(this, refresh),
			this.relayCanvas.sharedFolder.subscribeToPermissionChanges(refresh),
			() => { if (forced) canvas.setReadonly(previous); },
		);
		refresh();
	}

	/**
	 * Establish ownership from evidence that the rendered nodes belong to
	 * view.file: every rendered node and edge equals the file's own item
	 * of that id in its local CRDT or on disk, and there is at least one
	 * node. A view that still renders another file's content (even a
	 * copy's, which shares ids but not content once either side has
	 * changed), holds unsaved edits, or shows nothing while its load is in
	 * flight waits for the next setViewData or native save instead.
	 *
	 * Runs at construction, from every reconcile the machine emits while
	 * the view is unowned, and when a node enters an unowned view. A
	 * plugin that attaches after Obsidian's load has already run (a
	 * plugin reload with the canvas open, a reopened tab whose read
	 * finished first) never sees a setViewData for that load, so a single
	 * attempt is not enough; a load that populates the view by another
	 * path than setViewData still adds its nodes one by one. Concurrent
	 * requests coalesce into one read, with one more pass afterwards if a
	 * request arrived mid-flight — Obsidian adds a load's nodes in one
	 * synchronous burst, so the read that follows sees the whole load.
	 */
	private verifyViewDataOwnership(): void {
		if (this.viewDataOwned) return;
		if (this.ownershipCheck) {
			this.ownershipCheckQueued = true;
			return;
		}
		this.ownershipCheck = this.checkViewDataOwnership().finally(() => {
			this.ownershipCheck = null;
			if (this.ownershipCheckQueued) {
				this.ownershipCheckQueued = false;
				this.verifyViewDataOwnership();
			}
		});
	}

	private async checkViewDataOwnership(): Promise<void> {
		const file = this.view?.file;
		if (!file || !this.relayCanvas || file !== this.relayCanvas.tfile) {
			return;
		}
		try {
			const raw = await this.relayCanvas.vault.cachedRead(file);
			if (this.viewDataOwned || !this.canvas || !this.relayCanvas) return;
			if (this.view.file !== file) return;
			const parsed = (raw.trim().length > 0 ? JSON.parse(raw) : {}) as {
				nodes?: CanvasNodeData[];
				edges?: CanvasEdgeData[];
			};
			const diskData = {
				nodes: parsed.nodes ?? [],
				edges: parsed.edges ?? [],
			};
			const viewData = this.canvas.getData();
			const localData = this.relayCanvas.exportData();
			if (viewDataBelongsToFile(viewData, localData, diskData)) {
				this.debug(
					"view data ownership established from rendered content",
					file.path,
				);
				this.markViewDataOwned();
			} else {
				const foreign = foreignViewItems(viewData, localData, diskData);
				this.ownershipMismatches = [
					...foreign.nodes.map((n) => n.id),
					...foreign.edges.map((e) => e.id),
				];
				if (isDebugging()) {
					this.debug(
						"view data ownership deferred to next load",
						file.path,
						JSON.stringify({
							rendered: {
								nodes: viewData.nodes.length,
								edges: viewData.edges.length,
							},
							disk: { nodes: diskData.nodes.length, edges: diskData.edges.length },
							local: {
								nodes: localData.nodes.length,
								edges: localData.edges.length,
							},
							foreign,
						}),
					);
				}
			}
		} catch (e) {
			this.debug("view data ownership check failed; deferred to next load", e);
		}
	}

	/** Read-only wiring state for the debug surface. */
	wiringSnapshot(): {
		owned: boolean;
		loadSeq: number;
		trackedEmbeds: number;
		mismatched: string[];
	} {
		return {
			owned: this.viewDataOwned,
			loadSeq: this.loadSeq,
			trackedEmbeds: this.embedReleases.size,
			mismatched: [...this.ownershipMismatches],
		};
	}

	private markViewDataOwned(): void {
		if (this.viewDataOwned || !this.relayCanvas) return;
		this.viewDataOwned = true;
		this.ownershipMismatches = [];
		for (const node of this.canvas.nodes.values()) {
			this.adoptEmbed(node);
		}
		// Content that reached the localDoc before ownership was
		// established produced no view updates; ask the machine for a
		// reconcile now that the view may be written.
		this.relayCanvas.hsm.send({ type: "OBSIDIAN_SET_VIEW_DATA" });
	}

	destroy() {
		if (this.canvas) {
			// Each step is guarded: one failing release must not leave the
			// observers, patches, and reconciler installed on a plugin the
			// manager considers gone.
			for (const release of [...this.embedReleases.values()]) {
				try {
					release();
				} catch (e) {
					this.error("Error releasing canvas embed:", e);
				}
			}
			for (const unhook of this.nodeHooks.values()) {
				try {
					unhook();
				} catch (e) {
					this.error("Error unhooking canvas node:", e);
				}
			}
			this.nodeHooks.clear();
			this.nodeEmbeds.clear();
			this.embedReleases.clear();
			for (const unsubscribe of this.unsubscribes) {
				try {
					unsubscribe();
				} catch (e) {
					this.error("Error unsubscribing canvas plugin:", e);
				}
			}
			this.unsubscribes = [];
		}
		this.pendingViewIngest = null;
		this.ownershipCheckQueued = false;
		this.relayCanvasView.tracking = false;
		this.canvas = null as unknown as typeof this.canvas;
		this.relayCanvas = null as unknown as typeof this.relayCanvas;
		this.relayCanvasView = null as unknown as typeof this.relayCanvasView;
		this.unsubscribes.length = 0;
	}

	observeNode(node: CanvasNodeData) {
		if (this.observedTextNodes.has(node.id)) return;
		if (node.type === "text") {
			const ytext = this.relayCanvas.textNode(node);
			const nodeId = node.id;
			// One observer per node: observeNode runs again for every node
			// update that arrives through the CRDT, and a second observer on
			// the same Y.Text would deliver every later change twice.
			this.observedTextNodes.add(nodeId);
			const _textObserver = (event: Y.YTextEvent) => {
				// The same gate as every other view-facing path: a reused
				// view can render a copy's node under this id, and a write
				// into it would reach view.file through the save that
				// follows. Content that arrives before ownership reaches the
				// view through the reconcile ownership requests.
				if (!this.viewDataOwned) return;
				const node = this.canvas.nodes.get(nodeId);
				if (node) {
					if (this.adoptNodeText(node, ytext.toJSON())) {
						this.requestSaveAfterAdoption();
					}
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

	/**
	 * Give a card node the CRDT's text without writing through an open card
	 * editor.
	 *
	 * A card whose editor is open is driven by the CM6 binding, which applies
	 * each Y.Text delta to that editor as a sync-annotated dispatch and skips
	 * annotated transactions when it reads the editor back. Obsidian's setText
	 * replaces the editor's document with a plain transaction instead, and the
	 * binding reads a plain transaction as typing: it re-inserts those
	 * characters into the same Y.Text, so text delivered this way arrives
	 * twice and both copies replicate. Assigning the node's own text keeps
	 * getData, the save path, and the rendered card on the CRDT value and
	 * leaves the editor to the binding.
	 *
	 * Returns true when the editor was left alone this way.
	 */
	private adoptNodeText(node: CanvasNode, text: string): boolean {
		if (!node.isEditing) {
			node.setText(text);
			return false;
		}
		node.text = text;
		return true;
	}

	/**
	 * Ask Obsidian to save a canvas whose card text this plugin assigned
	 * directly. The card editor's own save is what marks the canvas dirty for
	 * that node, and it compares the editor's text against the node's — which
	 * already holds the delivered value — so it finds nothing to do and the
	 * file would never be written. Deferred past the CRDT transaction that
	 * delivered the text: a save reads the whole view, and every observer for
	 * that transaction has to have updated the view before it does, or the
	 * save reports a view that is missing content the transaction just added.
	 */
	private requestSaveAfterAdoption(): void {
		if (this.adoptionSaveQueued) return;
		this.adoptionSaveQueued = true;
		void Promise.resolve().then(() => {
			this.adoptionSaveQueued = false;
			if (!this.canvas || !this.relayCanvas) return;
			this.canvas.requestSave();
		});
	}

	/**
	 * Write shared canvas data into the view. Cards whose editor is open take
	 * their text first: importData reaches setText through setData, and
	 * setText writes through an open editor. Once the node already holds the
	 * text, Obsidian's setText finds nothing to change and leaves the editor
	 * alone.
	 */
	private importCanvasData(data: CanvasData): void {
		for (const nodeData of data.nodes) {
			if (nodeData.type !== "text") continue;
			if (typeof nodeData.text !== "string") continue;
			const node = this.canvas.nodes.get(nodeData.id);
			if (node?.isEditing) {
				this.adoptNodeText(node, nodeData.text);
			}
		}
		this.canvas.importData(data, true);
	}

	public markDirty(node: CanvasNodeData) {
		const fullNode = this.canvas.nodes.get(node.id);
		if (fullNode) {
			this.canvas.markDirty(fullNode);
		}
	}

	/**
	 * Wire the embed a node renders, once the view is owned. A file node's
	 * child does not exist until the node first renders, so a sweep at
	 * ownership time only reaches the children that exist by then; the
	 * render hook on every node brings the rest here as they appear. A
	 * node whose child was replaced releases the previous embed first.
	 * Each child is examined once per node: an embed whose file is not a
	 * shared document stays unwired, without a fresh lookup on every
	 * render.
	 */
	private adoptEmbed(node: CanvasNode): void {
		if (!this.viewDataOwned || !this.relayCanvas) return;
		const child = (node as RenderedCanvasNode).child;
		// A node whose child Obsidian has dropped keeps its previous
		// wiring until it renders a new child or is removed; the embed
		// editor it held is gone either way.
		if (!child?.file) return;
		const previous = this.nodeEmbeds.get(node);
		if (previous === child) return;
		if (previous) {
			this.releaseEmbed(previous);
		}
		this.nodeEmbeds.set(node, child);
		if (!this.embedReleases.has(child)) {
			const release = this.connectEmbedView(child);
			if (release) {
				this.embedReleases.set(child, release);
			}
		}
	}

	private releaseEmbed(embedView: EmbedEditorView): void {
		const release = this.embedReleases.get(embedView);
		if (release) {
			release();
		}
	}

	/**
	 * Watch a view node render so the embed it creates gets wired. Nodes
	 * arrive through the canvas's addNode (a load, an import, a person
	 * adding one) and leave through removeNode — Obsidian routes a file
	 * switch in a reused view, an undo, and clear() through it as well.
	 * Both are patched in install, and the nodes present at install are
	 * hooked there.
	 */
	private hookNode(node: CanvasNode): void {
		if (this.nodeHooks.has(node)) return;
		if (typeof (node as RenderedCanvasNode).render !== "function") return;
		const owner = () => this;
		const unpatch = getPatcher().patch(node, {
			render(old: (...args: unknown[]) => unknown) {
				return function (this: CanvasNode, ...args: unknown[]) {
					const res = old.apply(this, args);
					try {
						owner().adoptEmbed(this);
					} catch (e) {
						owner().log(e);
					}
					return res;
				};
			},
		});
		this.nodeHooks.set(node, unpatch);
		this.adoptEmbed(node);
	}

	private unhookNode(node: CanvasNode): void {
		const unpatch = this.nodeHooks.get(node);
		if (unpatch) {
			unpatch();
			this.nodeHooks.delete(node);
		}
		const embed = this.nodeEmbeds.get(node);
		if (embed) {
			this.nodeEmbeds.delete(node);
			this.releaseEmbed(embed);
		}
	}

	/**
	 * The surface this plugin reads off a markdown embed sub-view. Canvas
	 * node embeds are editor views Obsidian does not type.
	 */
	private createEmbedEditorViewRef(embedView: EmbedEditorView): EditorViewRef {
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

	/**
	 * Returns the release that undoes the wiring, or null when the embed
	 * has no shared document to wire to.
	 */
	private connectEmbedView(embedView: EmbedEditorView): (() => void) | null {
		if (!embedView.file) {
			return null;
		}

		// Only markdown embeds have CM6 editors that need ViewHookPlugin + HSM.
		// Canvas embeds render as canvas views, and media (images, SVG, PDF)
		// are SyncFiles — neither uses a text editor.
		const path: string = embedView.file.path;
		if (!path.endsWith(".md")) {
			return null;
		}

		let document: Document;
		try {
			const ifile = this.relayCanvas.sharedFolder.getFile(embedView.file);
			if (!isDocument(ifile)) {
				return null;
			}
			document = ifile;
		} catch {
			// No shared handle (membership refused or undecided): the
			// embed renders without live sync.
			return null;
		}

		return (() => {
			const viewRef = this.createEmbedEditorViewRef(embedView);
			const syncEmbedViewToDocument = this.syncEmbedViewToDocument.bind(this);
			const logError = this.error.bind(this);
			const plugin = new ViewHookPlugin(
				embedView as unknown as MarkdownView,
				document,
			);
			const requestSaveUnsubscribe = getPatcher().patch(embedView, {
				requestSave: (old: (...args: unknown[]) => unknown) => {
					return function (this: {
						__relaySaving?: boolean;
						app?: { metadataCache?: { trigger?: (name: string, file: unknown) => void } };
						file?: unknown;
					}) {
						if (!this?.__relaySaving) {
							try {
								syncEmbedViewToDocument(
									document,
									viewRef,
									"requestSave",
								);
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
			// One viewer per embed: two nodes embedding the same note hold
			// two locks, so releasing one on node removal leaves the other.
			const viewer: DocumentViewer = Symbol(`canvas-embed:${embedView.file.path}`);
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


					const cm = embedView.editor?.cm;
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
				this.embedReleases.delete(embedView);
				requestSaveUnsubscribe();
				plugin.destroy();
				if (lockAcquired) {
					this.connectionManager.releaseDocumentLock(
						document,
						viewer,
					);
				}
			};
		})();
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
		if (!this.viewDataOwned) {
			// The machine settled into a reconcile while the view is still
			// unowned: re-examine the evidence. Ownership granted this way
			// requests its own reconcile.
			this.verifyViewDataOwnership();
			return;
		}
		const pending = this.pendingViewIngest;
		if (pending) {
			// Consumed or voided either way: the record describes exactly
			// one load, and this reconcile is its one chance to act.
			this.pendingViewIngest = null;
			if (
				pending.seq === this.loadSeq &&
				pending.file === this.view.file
			) {
				// Obsidian already reconciled the external disk state into
				// the view (an id-preserving destructive import). Keep its
				// result untouched and converge the localDoc to it — never
				// the reverse.
				this.debug(
					"ingesting externally loaded view data",
					this.view.file?.path,
				);
				void this.relayCanvas
					.importFromView(this.view)
					.catch((e) => this.log(e));
				return;
			}
			// Stale (a later load or file switch intervened): fall through
			// to the merge path, the safe default.
			this.debug(
				"voiding stale pending view ingest",
				this.view.file?.path,
			);
		}
		// With an LCA the reconcile merges three-way — base = LCA, ours =
		// localDoc, theirs = the loaded view data — so external edits to
		// existing nodes survive a file open. Without a baseline, the
		// additive union protects a fresh localDoc from a stale disk file.
		const lcaData = this.relayCanvas.hsm.getLCAData?.();
		const viewData = this.canvas.getData();
		let merged: ReturnType<typeof mergeCanvasViewData>;
		if (lcaData) {
			const threeWay = mergeCanvasThreeWay(
				lcaData,
				this.relayCanvas.exportData(),
				viewData,
			);
			merged = areCanvasDataEqual(threeWay, viewData) ? null : threeWay;
		} else {
			merged = mergeCanvasViewData(this.relayCanvas.exportData(), viewData);
		}
		if (!merged) return;
		this.debug(
			"reconciling view with canvas localDoc",
			this.view.file?.path,
			merged,
		);
		this.importCanvasData(merged);
		this.canvas.requestSave();
	}

	private install() {
		if (!this.canvas) return;

		this.debug(
			"connecting canvas view to canvas",
			this.view.file?.path,
			this.relayCanvas.path,
		);

		const owner = () => this;

		const reconciler = () => this.reconcileViewWithCanvas();
		this.relayCanvas.setViewReconciler(reconciler);
		this.unsubscribes.push(() => {
			this.relayCanvas.clearViewReconciler(reconciler);
		});

		this.unsubscribes.push(
			getPatcher().patch(this.view, {
				setViewData(old: (...args: unknown[]) => unknown) {
					return function (data: string, clear: boolean) {
						const plugin = owner();
						// @ts-ignore
						const res = old.call(this, data, clear);
						// A load delivers view.file's own data, so it grants
						// ownership. The file load lands after install, so a
						// stale disk file would overwrite anything imported
						// earlier; the machine re-reconciles after every load.
						try {
							plugin.loadSeq++;
							// A non-clearing load of an already-owned view is
							// Obsidian ingesting an external disk change (file
							// opens always clear): the rendered view is disk
							// truth, and the reconcile must flow view→localDoc.
							// A clearing load — an ordinary file open — voids
							// any pending ingest: whatever load armed it has
							// been superseded, and consuming it against the
							// freshly opened file would destructively import
							// stale disk state.
							if (clear) {
								plugin.pendingViewIngest = null;
							} else if (
								plugin.viewDataOwned &&
								plugin.view.file &&
								plugin.view.file === plugin.relayCanvas.tfile
							) {
								plugin.pendingViewIngest = {
									seq: plugin.loadSeq,
									file: plugin.view.file,
								};
							}
							plugin.markViewDataOwned();
							plugin.relayCanvas.hsm.send({ type: "OBSIDIAN_SET_VIEW_DATA" });
						} catch (e) {
							plugin.log(e);
						}
						return res;
					};
				},
			}),
		);

		this.unsubscribes.push(
			getPatcher().patch(this.canvas, {
				requestSave(old: (...args: unknown[]) => unknown) {
					return function (this: unknown) {
						const plugin = owner();
						const res = old.call(this);
						try {
							// A native save writes the rendered data into
							// view.file, which makes that data the file's by
							// definition — this is what re-establishes
							// ownership for a view that held unsaved edits
							// when the plugin attached.
							plugin.markViewDataOwned();
							void plugin.relayCanvas.importFromView(plugin.view);
						} catch (e) {
							plugin.log(e);
						}
						return res;
					};
				},
				applyHistory(old: (...args: unknown[]) => unknown) {
					return function (data: unknown) {
						const plugin = owner();
						// @ts-ignore
						const res = old.call(this, data);
						try {
							if (plugin.viewDataOwned) {
								void plugin.relayCanvas.importFromView(plugin.view);
							}
						} catch (e) {
							plugin.log(e);
						}
						return res;
					};
				},
			}),
		);

		// Node lifecycle. Without these two methods, embeds are wired only
		// from the ownership sweep and the CRDT observers, which reach a
		// child only if it already exists when they run.
		const nodeLifecycle: Record<string, unknown> = {};
		if (typeof this.canvas.addNode === "function") {
			nodeLifecycle.addNode = (old: (...args: unknown[]) => unknown) =>
				function (this: unknown, node: CanvasNode, ...rest: unknown[]) {
					const res = old.call(this, node, ...rest);
					try {
						const plugin = owner();
						plugin.hookNode(node);
						// A node entering an unowned view is a load landing by
						// whatever path; re-examine the evidence once it is in.
						plugin.verifyViewDataOwnership();
					} catch (e) {
						owner().log(e);
					}
					return res;
				};
		} else {
			this.warn("canvas has no addNode; embeds rendered later stay unwired");
		}
		if (typeof this.canvas.removeNode === "function") {
			nodeLifecycle.removeNode = (old: (...args: unknown[]) => unknown) =>
				function (this: unknown, node: CanvasNode, ...rest: unknown[]) {
					try {
						owner().unhookNode(node);
					} catch (e) {
						owner().log(e);
					}
					return old.call(this, node, ...rest);
				};
		} else {
			this.warn("canvas has no removeNode; embed wiring is released only on destroy");
		}
		if (Object.keys(nodeLifecycle).length > 0) {
			this.unsubscribes.push(getPatcher().patch(this.canvas, nodeLifecycle));
		}
		for (const node of this.canvas.nodes.values()) {
			this.hookNode(node);
		}

		const _observer = <T extends CanvasNodeData | CanvasEdgeData>(
			event: Y.YMapEvent<T>,
			store: Map<string, CanvasNode> | Map<string, CanvasEdge>,
		) => {
			let log = "";
			log += `Transaction origin: ${event.transaction.origin} ${(event.transaction.origin as { constructor?: { name?: string } } | null)?.constructor?.name}\n`;
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
			this.importCanvasData(exported);
			this.canvas.requestSave();
			for (const key of event.keysChanged as Set<string>) {
				const node = store.get(key);
				if (node) {
					if (this.canvas.nodes.has(node.id)) {
						this.observeNode((node as CanvasNode).getData());
						this.adoptEmbed(node as CanvasNode);
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
