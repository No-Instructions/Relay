import type { Extension } from "@codemirror/state";
import { StateField, EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	App,
	MarkdownView,
	Platform,
	requireApiVersion,
	TFile,
	TextFileView,
	Workspace,
	moment,
	type CachedMetadata,
} from "obsidian";
import ViewActions from "src/components/ViewActions.svelte";
import * as Y from "yjs";
import { Document } from "./Document";
import type { ConnectionState } from "./HasProvider";
import { LoginManager } from "./LoginManager";
import NetworkStatus from "./NetworkStatus";
import { SharedFolder, SharedFolders } from "./SharedFolder";
import { curryLog, HasLogging, RelayInstances } from "./debug";
import { Banner } from "./ui/Banner";
import { LiveEdit } from "./y-codemirror.next/LiveEditPlugin";
import { HSMEditorPlugin } from "./merge-hsm/integration/HSMEditorPlugin";
import {
	yRemoteSelections,
	yRemoteSelectionsTheme,
} from "./y-codemirror.next/RemoteSelections";
import {
	conflictDecorationPlugin,
	conflictDecorationTheme,
} from "./y-codemirror.next/ConflictDecorationPlugin";
import { InvalidLinkPlugin } from "./markdownView/InvalidLinkExtension";
import * as Differ from "./differ/differencesView";
import type { CanvasView } from "./CanvasView";
import { isCanvas, type Canvas } from "./Canvas";
import { CanvasPlugin } from "./CanvasPlugin";
import { LiveNode } from "./y-codemirror.next/LiveNodePlugin";
import { flags } from "./flagManager";
import { AwarenessViewPlugin } from "./AwarenessViewPlugin";
import { TextFileViewPlugin } from "./TextViewPlugin";
import { DiskBuffer } from "./DiskBuffer";

const BACKGROUND_CONNECTIONS = 3;

function iterateCanvasViews(
	workspace: Workspace,
	fn: (leaf: CanvasView) => void,
) {
	workspace.iterateAllLeaves((leaf) => {
		if (leaf.view.getViewType() === "canvas") {
			fn(leaf.view as unknown as CanvasView);
		}
	});
}

function iterateTextFileViews(
	workspace: Workspace,
	fn: (leaf: TextFileView) => void,
) {
	const ALLOWED_TEXT_FILE_VIEWS = ["markdown"];
	if (flags().enableKanbanView) {
		ALLOWED_TEXT_FILE_VIEWS.push("kanban");
	}
	const allLeaves: any[] = [];

	workspace.iterateAllLeaves((leaf) => {
		allLeaves.push({
			viewType: leaf.view?.getViewType?.() || "unknown",
			filePath: (leaf.view as any)?.file?.path || "no-file",
			isTextFileView: leaf.view instanceof TextFileView,
			leafType: leaf.view.constructor.name,
		});
	});

	workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof TextFileView) {
			const viewType = leaf.view.getViewType();
			if (viewType === "canvas") return;
			if (ALLOWED_TEXT_FILE_VIEWS.contains(viewType)) {
				fn(leaf.view);
			}
		}
	});
}

function ViewsetsEqual(vs1: S3View[], vs2: S3View[]): boolean {
	if (vs1.length !== vs2.length) {
		return false;
	}

	for (let i = 0; i < vs1.length; i++) {
		if (vs1[i].view.file?.path !== vs2[i].view.file?.path) {
			return false;
		}
		if (vs1[i].document?.path !== vs2[i].document?.path) {
			return false;
		}
	}
	return true;
}

export interface S3View {
	view: TextFileView | CanvasView;
	release: () => void;
	attach: () => Promise<S3View>;
	document: Document | Canvas | null;
	destroy: () => void;
	canConnect: boolean;
	offlineBanner?: () => () => void;
}

export class LoggedOutView implements S3View {
	view: TextFileView | CanvasView;
	login: () => Promise<boolean>;
	banner?: Banner;
	document = null;
	canConnect = false;

	private _parent: LiveViewManager;

	constructor(
		connectionManager: LiveViewManager,
		view: TextFileView | CanvasView,
		login: () => Promise<boolean>,
	) {
		this._parent = connectionManager; // for debug
		this.view = view;
		this.login = login;
	}

	attach(): Promise<S3View> {
		this.banner = new Banner(
			this.view,
			{ short: "Login to Relay", long: "Login to enable Live edits" },
			async () => {
				return await this.login();
			},
		);
		return Promise.resolve(this);
	}

	release() {
		this.banner?.destroy();
	}

	destroy() {
		this.banner?.destroy();
		this.banner = undefined;
		this.view = null as any;
	}
}

export function isLiveMd(view?: S3View): view is LiveView<MarkdownView> {
	return (
		view instanceof LiveView &&
		view.view instanceof MarkdownView &&
		view.document !== undefined &&
		view.document.text !== undefined
	);
}

export function isLive(view?: S3View): view is LiveView<TextFileView> {
	return (
		view instanceof LiveView &&
		view.document !== undefined &&
		view.document.text !== undefined
	);
}

export function isRelayCanvasView(view?: S3View): view is RelayCanvasView {
	return view instanceof RelayCanvasView && view.document !== undefined;
}

export class RelayCanvasView implements S3View {
	view: CanvasView;
	canvas: Canvas;
	shouldConnect: boolean;
	canConnect: boolean;
	plugin?: CanvasPlugin;
	document: Canvas;

	private _viewActions?: ViewActions;
	private offConnectionStatusSubscription?: () => void;
	private _parent: LiveViewManager;
	private _banner?: Banner;
	tracking: boolean;

	constructor(
		connectionManager: LiveViewManager,
		view: CanvasView,
		canvas: Canvas,
		shouldConnect = true,
		canConnect = true,
	) {
		this._parent = connectionManager; // for debug
		this.view = view;
		this.canvas = canvas;
		this.document = canvas;
		this.tracking = false;

		this.shouldConnect = shouldConnect;
		this.canConnect = canConnect;
		if (!connectionManager.networkStatus.online) {
			this.offlineBanner();
		}
	}

	toggleConnection() {
		this.shouldConnect = !this.shouldConnect;
		if (this.shouldConnect) {
			this.canvas.connect().then((connected) => {
				if (!connected) {
					// If we couldn't connect, ensure their next press tries again.
					this.shouldConnect = false;
				}
			});
		} else {
			this.canvas.disconnect();
		}
	}

	offlineBanner(): () => void {
		if (this.shouldConnect) {
			const banner = new Banner(
				this.view,
				{ short: "Offline", long: "You're offline -- click to reconnect" },
				async () => {
					this._parent.networkStatus.checkStatus();
					this.connect();
					return this._parent.networkStatus.online;
				},
			);
			this._parent.networkStatus.onceOnline(() => {
				this.connect();
				banner.destroy();
			});
		}
		return () => {};
	}

	setConnectionDot(): void {
		const viewActionsElement =
			this.view.containerEl.querySelector(".view-actions");
		if (viewActionsElement && viewActionsElement.firstChild) {
			if (!this._viewActions) {
				this.clearViewActions();
				if (this.offConnectionStatusSubscription) {
					this.offConnectionStatusSubscription();
				}
				this._viewActions = new ViewActions({
					target: viewActionsElement,
					anchor: viewActionsElement.firstChild as Element,
					props: {
						view: this,
						state: this.canvas.state,
						remote: this.canvas.sharedFolder.remote,
					},
				});
				this.offConnectionStatusSubscription = this.canvas.subscribe(
					viewActionsElement,
					(state: ConnectionState) => {
						this._viewActions?.$set({
							view: this,
							state: state,
							remote: this.canvas.sharedFolder.remote,
						});
					},
				);
			}
			this._viewActions.$set({
				view: this,
				state: this.canvas.state,
				remote: this.canvas.sharedFolder.remote,
			});
		}
	}

	clearViewActions() {
		const viewActionsElement =
			this.view.containerEl.querySelector(".view-actions");
		if (viewActionsElement && viewActionsElement.firstChild) {
			const viewActions = this.view.containerEl.querySelectorAll(
				".system3-view-action",
			);
			if (viewActions.length > 0) {
				viewActions.forEach((viewAction) => {
					viewAction.remove();
				});
			}
		}
	}

	attach(): Promise<RelayCanvasView> {
		// can be called multiple times, whereas release is only ever called once
		this.canvas.userLock = true;

		// Add CSS class to indicate this view should have live editing
		this.view.containerEl.addClass("relay-live-editor");

		this.setConnectionDot();

		if (!this.plugin) {
			this.plugin = new CanvasPlugin(this._parent, this);
		}

		return new Promise((resolve) => {
			return this.canvas
				.whenReady()
				.then((doc) => {
					if (
						this._parent.networkStatus.online &&
						this.canvas.sharedFolder.shouldConnect &&
						this.shouldConnect &&
						this.canConnect
					) {
						this.connect();
					} else {
						this.canvas.disconnect();
					}
					resolve(this);
				})
				.catch(() => {
					this.offlineBanner();
				});
		});
	}

	connect() {
		this.canvas.connect();
	}

	release() {
		// Called when a view is released from management

		// Remove the live editor class
		this.view.containerEl.removeClass("relay-live-editor");

		this.plugin?.destroy();
		this.plugin = undefined;
		this._viewActions?.$destroy();
		this._viewActions = undefined;
		this._banner?.destroy();
		this._banner = undefined;
		if (this.offConnectionStatusSubscription) {
			this.offConnectionStatusSubscription();
			this.offConnectionStatusSubscription = undefined;
		}
		this.canvas.disconnect();
		this.canvas.releaseLock();
	}

	destroy() {
		this.plugin?.destroy();
		this.plugin = null as any;
		this.release();
		this.clearViewActions();
		(this.view.leaf as any).rebuildView?.();
		this._parent = null as any;
		this.view = null as any;
		this.canvas = null as any;
	}
}

export class LiveView<ViewType extends TextFileView>
	extends HasLogging
	implements S3View
{
	view: ViewType;
	document: Document;
	shouldConnect: boolean;
	canConnect: boolean;
	private _plugin?: TextFileViewPlugin;

	private _viewActions?: ViewActions;
	private offConnectionStatusSubscription?: () => void;
	private _parent: LiveViewManager;
	private _banner?: Banner;
	_tracking: boolean;
	private _awarenessPlugin?: AwarenessViewPlugin;
	private _hsmStateUnsubscribe?: () => void;

	constructor(
		connectionManager: LiveViewManager,
		view: ViewType,
		document: Document,
		shouldConnect = true,
		canConnect = true,
	) {
		super();
		this._parent = connectionManager; // for debug
		this.view = view;
		this.document = document;
		this._tracking = false;

		this.shouldConnect = shouldConnect;
		this.canConnect = canConnect;
		if (!connectionManager.networkStatus.online) {
			this.offlineBanner();
		}
	}

	toggleConnection() {
		this.shouldConnect = !this.shouldConnect;
		if (this.shouldConnect) {
			this.document.connect().then((connected) => {
				if (!connected) {
					// If we couldn't connect, ensure their next press tries again.
					this.shouldConnect = false;
				}
			});
		} else {
			this.document.disconnect();
		}
	}

	public get tracking() {
		if (this.document?.hsm) {
			return this.document.hsm.state.statePath === "active.tracking";
		}
		return this._tracking;
	}

	public set tracking(value: boolean) {
		const old = this._tracking;
		this._tracking = value;
		// Only call attach for non-HSM mode (fallback for views without HSM)
		if (this._tracking !== old && !this.document?.hsm) {
			this.attach();
		}
	}

	public get ytext(): Y.Text {
		return this.document.ytext;
	}

	public get connectionManager(): LiveViewManager {
		return this._parent;
	}

	public async syncViewToCRDT(): Promise<void> {
		if (this._plugin && typeof this._plugin.syncViewToCRDT === "function") {
			await this._plugin.syncViewToCRDT();
		}
	}

	mergeBanner(): () => void {
		this._banner = new Banner(
			this.view,
			{ short: "Merge conflict", long: "Merge conflict -- click to resolve" },
			async () => {
				// HSM-aware conflict resolution path
				const hsm = this.document.hsm;
				if (hsm) {
					const conflictData = hsm.getConflictData();
					const localDoc = hsm.getLocalDoc();
					if (
						conflictData &&
						localDoc &&
						hsm.state.statePath.includes("conflict")
					) {
						this.log("[mergeBanner] Opening diff view for conflict resolution");

						// Check if there are inline conflict regions (new flow)
						const hasInlineConflicts =
							conflictData.conflictRegions &&
							conflictData.conflictRegions.length > 0;

						if (hasInlineConflicts) {
							// With inline conflicts, clicking banner opens diff view as alternative
							this.log(
								"[mergeBanner] Inline conflicts present, opening diff view as alternative",
							);
						}

						// Get CURRENT localDoc content (not stale conflictData.local)
						const currentLocalContent = localDoc.getText("contents").toString();
						const diskContent = conflictData.remote;

						this.log(
							`[mergeBanner] localDoc: ${currentLocalContent.length} chars, disk: ${diskContent.length} chars`,
						);

						// Create DiskBuffer wrappers (differ expects TFile-like objects)
						// Use DiskBuffer for BOTH sides to ensure we show correct content
						const localFile = new DiskBuffer(
							this._parent.app.vault,
							this.document.path + " (Local)",
							currentLocalContent,
						);
						const diskFile = new DiskBuffer(
							this._parent.app.vault,
							this.document.path + " (Disk)",
							diskContent,
						);

						// Transition HSM to resolving state
						hsm.send({ type: "OPEN_DIFF_VIEW" });

						// Open diff view: localDoc (left) vs disk (right)
						this._parent.openDiffView({
							file1: localFile, // Current localDoc content
							file2: diskFile, // Disk content
							showMergeOption: true,
							onResolve: async () => {
								this.log("[mergeBanner] HSM conflict resolved via diff view");

								// The differ modifies file1 (localFile) in-place via its contents.
								// Get the resolved content and apply it to HSM's localDoc.
								const resolvedContent = localFile.contents;

								if (resolvedContent === currentLocalContent) {
									// User kept local - just update LCA
									hsm.send({ type: "RESOLVE_ACCEPT_LOCAL" });
								} else if (resolvedContent === diskContent) {
									// User chose disk
									hsm.send({ type: "RESOLVE_ACCEPT_DISK" });
								} else {
									// User merged - send merged content
									hsm.send({
										type: "RESOLVE_ACCEPT_MERGED",
										contents: resolvedContent,
									});
								}

								this._banner?.destroy();
								this._banner = undefined;
							},
						});
						return false; // Don't destroy banner yet - wait for resolution
					}
				}
				return false;
			},
		);
		return () => {};
	}

	offlineBanner(): () => void {
		if (this.shouldConnect) {
			const banner = new Banner(
				this.view,
				{ short: "Offline", long: "You're offline -- click to reconnect" },
				async () => {
					this._parent.networkStatus.checkStatus();
					this.connect();
					return this._parent.networkStatus.online;
				},
			);
			this._parent.networkStatus.onceOnline(() => {
				this.connect();
				banner.destroy();
			});
		}
		return () => {};
	}

	setConnectionDot(): void {
		const viewActionsElement =
			this.view.containerEl.querySelector(".view-actions");
		if (viewActionsElement && viewActionsElement.firstChild) {
			if (!this._viewActions) {
				this.clearViewActions();
				if (this.offConnectionStatusSubscription) {
					this.offConnectionStatusSubscription();
				}
				this._viewActions = new ViewActions({
					target: viewActionsElement,
					anchor: viewActionsElement.firstChild as Element,
					props: {
						view: this,
						state: this.document.state,
						remote: this.document.sharedFolder.remote,
					},
				});
				this.offConnectionStatusSubscription = this.document.subscribe(
					viewActionsElement,
					(state: ConnectionState) => {
						this._viewActions?.$set({
							view: this,
							state: state,
							remote: this.document.sharedFolder.remote,
						});
					},
				);
			}
			this._viewActions.$set({
				view: this,
				state: this.document.state,
				remote: this.document.sharedFolder.remote,
			});
		}
	}

	clearViewActions() {
		const viewActionsElement =
			this.view.containerEl.querySelector(".view-actions");
		if (viewActionsElement && viewActionsElement.firstChild) {
			const viewActions = this.view.containerEl.querySelectorAll(
				".system3-view-action",
			);
			if (viewActions.length > 0) {
				viewActions.forEach((viewAction) => {
					viewAction.remove();
				});
			}
		}
	}

	async checkStale() {
		if (
			this.view instanceof MarkdownView &&
			this.view.getMode() === "preview"
		) {
			this.log("[LiveView.checkStale] skipping - preview mode");
			return false;
		}

		// Use HSM conflict detection
		const hsmConflict = this.document.hasHSMConflict();
		this.log(`[LiveView.checkStale] HSM conflict detection: ${hsmConflict}`);
		if (hsmConflict === true) {
			this.log(
				"[LiveView.checkStale] HSM reports conflict, showing merge banner",
			);
			this.mergeBanner();
			return true;
		} else {
			this._banner?.destroy();
			this._banner = undefined;
			return false;
		}
	}

	attach(): Promise<this> {
		// can be called multiple times, whereas release is only ever called once
		// Use HSM acquireLock if available, otherwise falls back to userLock internally
		this.document
			.acquireLock()
			.then((hsm) => {
				// Subscribe to HSM state changes for automatic conflict banner handling
				// Must happen AFTER acquireLock completes so hsm is available
				if (hsm && !this._hsmStateUnsubscribe) {
					this._hsmStateUnsubscribe = hsm.stateChanges.subscribe((state) => {
						const isConflict = state.statePath.includes("conflict");
						this.log(
							`[LiveView.attach] HSM state changed: ${state.statePath}, isConflict: ${isConflict}`,
						);

						// Update ViewActions to reflect tracking state change
						this._viewActions?.$set({
							view: this,
							state: this.document.state,
							remote: this.document.sharedFolder.remote,
						});

						if (isConflict && !this._banner) {
							this.log(
								"[LiveView.attach] HSM entered conflict state, showing merge banner",
							);
							this.mergeBanner();
						} else if (!isConflict && this._banner) {
							this.log(
								"[LiveView.attach] HSM exited conflict state, hiding merge banner",
							);
							this._banner.destroy();
							this._banner = undefined;
						}
					});
				}
			})
			.catch((e) => {
				this.warn("[LiveView.attach] acquireLock failed:", e);
			});

		// Add CSS class to indicate this view should have live editing
		if (this.view instanceof MarkdownView) {
			this.view.containerEl.addClass("relay-live-editor");
		}

		if (!(this.view instanceof MarkdownView)) {
			if (!this._plugin) {
				this.warn("[LiveView] Creating TextFileViewPlugin in attach() for:", {
					path: this.document.path,
					viewType: this.view.getViewType?.(),
					viewFilePath: this.view.file?.path,
				});
				this._plugin = new TextFileViewPlugin(this);
			}
		}

		this.setConnectionDot();

		// Initialize awareness plugin if not already created and feature flag is enabled
		if (
			isLiveMd(this) &&
			!this._awarenessPlugin &&
			flags().enablePresenceAvatars
		) {
			this._awarenessPlugin = new AwarenessViewPlugin(
				this,
				this._parent.sharedFolders.manager.users,
			);
		}

		return new Promise((resolve) => {
			return this.document
				.whenReady()
				.then((doc) => {
					if (
						this._parent.networkStatus.online &&
						this.document.sharedFolder.shouldConnect &&
						this.shouldConnect &&
						this.canConnect
					) {
						this.connect();
					} else {
						this.document.disconnect();
					}
					resolve(this);
				})
				.catch(() => {
					this.offlineBanner();
				});
		});
	}

	connect() {
		this.document.connect();
	}

	release() {
		// Called when a view is released from management

		// Remove the live editor class
		if (this.view instanceof MarkdownView) {
			this.view.containerEl.removeClass("relay-live-editor");
		}

		this._viewActions?.$destroy();
		this._viewActions = undefined;
		this._banner?.destroy();
		this._banner = undefined;
		if (this.offConnectionStatusSubscription) {
			this.offConnectionStatusSubscription();
			this.offConnectionStatusSubscription = undefined;
		}
		// Clean up HSM state subscription
		if (this._hsmStateUnsubscribe) {
			this._hsmStateUnsubscribe();
			this._hsmStateUnsubscribe = undefined;
		}
		this._awarenessPlugin?.destroy();
		this._awarenessPlugin = undefined;
		this._plugin?.destroy();
		this._plugin = undefined;
		this.document.disconnect();
		this.document.releaseLock();
	}

	destroy() {
		this.release();
		this.clearViewActions();
		(this.view.leaf as any).rebuildView?.();
		this._parent = null as any;
		this.view = null as any;
		this.document = null as any;
		this._plugin = null as any;
	}
}

export class LiveViewManager {
	destroyed = false;
	workspace: Workspace;
	views: S3View[];
	private _activePromise?: Promise<boolean> | null;
	_compartment: Compartment;
	private loginManager: LoginManager;
	private offListeners: (() => void)[] = [];
	private folderListeners: Map<SharedFolder, () => void> = new Map();
	private metadataListeners: Map<
		TFile,
		(data: string, cache: CachedMetadata) => void
	>;
	sharedFolders: SharedFolders;
	extensions: Extension[];
	networkStatus: NetworkStatus;
	refreshQueue: (() => Promise<boolean>)[];
	log: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;

	constructor(
		public app: App,
		sharedFolders: SharedFolders,
		loginManager: LoginManager,
		networkStatus: NetworkStatus,
	) {
		this.workspace = app.workspace;
		this.sharedFolders = sharedFolders;
		this.views = [];
		this.extensions = [];
		this._activePromise = null;
		this.loginManager = loginManager;
		this.networkStatus = networkStatus;
		this.refreshQueue = [];
		this._compartment = new Compartment();

		this.log = curryLog("[LiveViews]", "log");
		this.warn = curryLog("[LiveViews]", "warn");

		this.metadataListeners = new Map();
		const cb = (tfile: TFile, data: string, cache: CachedMetadata) => {
			const sub = this.metadataListeners.get(tfile);
			sub?.(data, cache);
		};

		const offRef = this.app.metadataCache.on("changed", cb);
		this.offListeners.push(() => {
			this.app.metadataCache.offref(offRef);
		});

		this.offListeners.push(
			this.loginManager.on(() => {
				this.refresh("[LoginManager]");
			}),
		);

		const folderSub = (folder: SharedFolder) => {
			if (!folder.ready) {
				(async () => {
					folder
						.whenReady()
						.then(() => {
							this.refresh("[Shared Folder Ready]");
						})
						.catch((_) => {
							this.views.forEach((view) => {
								if (view.document?.sharedFolder === folder) {
									view.offlineBanner?.();
								}
							});
						});
				})();
			}

			return folder.fset.on(() => {
				this.refresh("[Docset]");
			});
		};

		this.offListeners.push(
			this.sharedFolders.subscribe(() => {
				this.refresh("[Shared Folders]");
				this.folderListeners.forEach((off, folder) => {
					if (!this.sharedFolders.has(folder)) {
						off();
						this.folderListeners.delete(folder);
					}
				});
				this.sharedFolders.forEach((folder) => {
					if (!this.folderListeners.has(folder)) {
						this.folderListeners.set(folder, folderSub(folder));
					}
				});
			}),
		);
		RelayInstances.set(this, "LiveViewManager");
	}

	reconfigure(editorView: EditorView) {
		editorView.dispatch({
			effects: this._compartment.reconfigure([
				ConnectionManagerStateField.init(() => {
					return this;
				}),
			]),
		});
	}

	onMeta(tfile: TFile, cb: (data: string, cache: CachedMetadata) => void) {
		this.metadataListeners.set(tfile, cb);
	}

	offMeta(tfile: TFile) {
		this.metadataListeners.delete(tfile);
	}

	openDiffView(state: Differ.ViewState) {
		Differ.openDiffView(this.workspace, state);
	}

	goOffline() {
		this.log("[System 3][Relay][Live Views] going offline");
		this.views.forEach((view) => view.document?.disconnect());
		this.refresh("[NetworkStatus]");
	}

	goOnline() {
		this.log("[System 3][Relay][Live Views] going online");
		this.refresh("[NetworkStatus]");
		this.sharedFolders.items().forEach((folder: SharedFolder) => {
			folder.connect();
		});
		this.viewsAttachedWithConnectionPool(this.views);
	}

	docIsOpen(doc: Document): boolean {
		return this.views.some((view) => view.document === doc);
	}

	/**
	 * Notify MergeManagers which documents have open editors.
	 * Groups views by their shared folder and calls setActiveDocuments() on each.
	 * This transitions HSMs from 'loading' to the appropriate mode (idle or active).
	 *
	 * Per spec (Gap 8): LiveViews sends bulk update to MergeManager indicating which
	 * documents have open editors. MergeManager fans out SET_MODE_ACTIVE to those HSMs,
	 * and SET_MODE_IDLE to all others.
	 */
	private async updateMergeManagerActiveDocuments(views: S3View[]): Promise<void> {
		// Group document GUIDs by their shared folder
		const folderToGuids = new Map<SharedFolder, Set<string>>();

		for (const view of views) {
			const doc = view.document;
			if (!doc) continue;

			const folder = doc.sharedFolder;
			if (!folder?.mergeManager) continue;

			if (!folderToGuids.has(folder)) {
				folderToGuids.set(folder, new Set());
			}
			folderToGuids.get(folder)!.add(doc.guid);
		}

		// Wait for all folders to complete their pending registrations
		// This ensures HSMs are registered before we set their mode
		const waitPromises: Promise<void>[] = [];
		for (const folder of this.sharedFolders.items()) {
			if (folder.mergeManager) {
				waitPromises.push(folder.mergeManager.whenRegistered());
			}
		}
		await Promise.all(waitPromises);

		// Call setActiveDocuments on each folder's MergeManager
		for (const [folder, guids] of folderToGuids) {
			folder.mergeManager.setActiveDocuments(guids);
		}

		// Also notify folders with no active views (all HSMs should be idle)
		for (const folder of this.sharedFolders.items()) {
			if (!folderToGuids.has(folder) && folder.mergeManager) {
				folder.mergeManager.setActiveDocuments(new Set());
			}
		}
	}

	private releaseViews(views: S3View[]) {
		views.forEach((view) => {
			view.release();
		});
	}

	private findFolders(): SharedFolder[] {
		const folders: Set<SharedFolder> = new Set<SharedFolder>();
		iterateTextFileViews(this.workspace, (textFileView) => {
			// Check if the view is displaying a file
			const viewFilePath = textFileView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		iterateCanvasViews(this.workspace, (canvasView) => {
			// Check if the view is displaying a file
			const viewFilePath = canvasView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		if (folders.size == 0) {
			return [];
		}
		return [...folders];
	}

	private async foldersReady(): Promise<SharedFolder[]> {
		const folders: Set<SharedFolder> = new Set<SharedFolder>();
		iterateTextFileViews(this.workspace, (textFileViews) => {
			// Check if the view is displaying a file
			const viewFilePath = textFileViews.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		iterateCanvasViews(this.workspace, (canvasView) => {
			// Check if the view is displaying a file
			const viewFilePath = canvasView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		if (folders.size === 0) {
			return [];
		}
		const readyFolders = [...folders].map((folder) => folder.whenReady());
		return Promise.all(readyFolders);
	}

	private async getViews(): Promise<S3View[]> {
		const views: S3View[] = [];
		iterateTextFileViews(this.workspace, async (textFileView) => {
			const viewFilePath = textFileView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				if (!this.loginManager.loggedIn) {
					const view = new LoggedOutView(this, textFileView, () => {
						return this.loginManager.openLoginPage();
					});
					views.push(view);
				} else if (folder.ready) {
					const doc = folder.proxy.getDoc(viewFilePath);
					const view = new LiveView<typeof textFileView>(
						this,
						textFileView,
						doc,
					);
					views.push(view);
				} else {
					this.log(`Folder not ready, skipping views. folder=${folder.path}`);
				}
			}
		});

		iterateCanvasViews(this.workspace, (canvasView) => {
			const viewFilePath = canvasView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder && canvasView.file) {
				if (!this.loginManager.loggedIn) {
					const view = new LoggedOutView(this, canvasView, () => {
						return this.loginManager.openLoginPage();
					});
					views.push(view);
				} else if (folder.ready) {
					const canvas = folder.getFile(canvasView.file);
					if (isCanvas(canvas)) {
						const view = new RelayCanvasView(this, canvasView, canvas);
						views.push(view);
					} else {
						this.log(`Skipping canvas view connection for ${viewFilePath}`);
					}
				} else {
					this.log(`Folder not ready, skipping views. folder=${folder.path}`);
				}
			}
		});

		return views;
	}

	findView(cmEditor: EditorView): LiveView<MarkdownView> | undefined {
		return this.views.filter(isLiveMd).find((view) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const editor = view.view.editor as any;
			const cm = editor.cm as EditorView;
			return cm === cmEditor;
		});
	}

	findCanvas(cmEditor: EditorView): RelayCanvasView | undefined {
		const state = (cmEditor.state as any).values.find((state: any) => {
			if (state && state.node) return state.node;
		});
		if (!state) return;
		return this.views.filter(isRelayCanvasView).find((view) => {
			return view.view.canvas === state.node.canvas;
		});
	}

	private async viewsReady(views: S3View[]): Promise<LiveView<TextFileView>[]> {
		return await Promise.all(
			views
				.filter(isLive)
				.map(async (view) => view.document.whenReady().then((_) => view)),
		);
	}

	private async viewsAttachedWithConnectionPool(
		views: S3View[],
		backgroundConnections: number = BACKGROUND_CONNECTIONS,
	): Promise<S3View[]> {
		const activeView =
			this.workspace.getActiveViewOfType<TextFileView>(TextFileView);

		let attemptedConnections = 0;

		const viewHistory = views.sort(
			(a, b) =>
				(b.view.leaf as any).activeTime - (a.view.leaf as any).activeTime,
		);
		const connectedDocuments = new Set<Document>();
		for (const view of viewHistory) {
			if (view instanceof LiveView) {
				if (view.view === activeView || connectedDocuments.has(view.document)) {
					view.canConnect = true;
					connectedDocuments.add(view.document);
				} else if (attemptedConnections < backgroundConnections) {
					view.canConnect = true;
					connectedDocuments.add(view.document);
					attemptedConnections++;
				} else {
					view.canConnect = false;
				}
			}
		}

		if (attemptedConnections > backgroundConnections) {
			this.warn(
				`[System 3][Relay][Live Views] connection pool (max ${backgroundConnections}): rejected connections for ${
					attemptedConnections - backgroundConnections
				} views`,
			);
		}

		return this.viewsAttached(views);
	}

	private async viewsAttached(views: S3View[]): Promise<S3View[]> {
		return await Promise.all(
			views.map(async (view) => {
				return view.attach();
			}),
		);
	}

	private deduplicate(views: S3View[]): [S3View[], S3View[]] {
		const stale: S3View[] = [];
		const matching: S3View[] = [];
		this.views.forEach((oldView) => {
			const found = views.find((newView) => {
				if (
					oldView.document == newView.document &&
					oldView.view == newView.view
				) {
					return true;
				}
			});
			if (found) {
				matching.push(oldView);
				views.remove(found);
			} else {
				stale.push(oldView);
			}
		});
		views.forEach((view) => {
			matching.push(view);
		});
		return [matching, stale];
	}

	async _refreshViews(
		context: string,
		queuedAt: moment.Moment,
	): Promise<boolean> {
		const ctx = `[LiveViews][${context}]`;
		const log = curryLog(ctx, "debug");
		const logViews = (message: string, views: S3View[]) => {
			log(
				message,
				views.map((view) => ({
					type: view.constructor.name,
					file: view.document?.path,
					canConnect: view.canConnect,
				})),
			);
		};
		log("Refresh");

		if (this.destroyed) return false;

		await this.foldersReady();

		let views: S3View[] = [];
		try {
			views = await this.getViews();
		} catch (e) {
			this.warn("[System 3][Relay][Live Views] error getting views", e);
			return false;
		}
		const activeDocumentFolders = this.findFolders();

		// Notify MergeManagers which documents have open editors (Gap 8: mode determination)
		// This transitions HSMs from 'loading' to the appropriate mode before attach() calls acquireLock()
		await this.updateMergeManagerActiveDocuments(views);

		if (activeDocumentFolders.length === 0 && views.length === 0) {
			if (this.extensions.length !== 0) {
				log("Unexpected plugins loaded.");
				this.wipe();
			}
			logViews("Releasing Views", this.views);
			this.releaseViews(this.views);
			this.views = [];
			return true; // no live views open
		}

		if (this.loginManager.loggedIn && this.networkStatus.online) {
			activeDocumentFolders.forEach((folder) => {
				folder.connect();
			});
		} else {
			this.sharedFolders.forEach((folder) => {
				folder.disconnect();
			});
		}

		const [matching, stale] = this.deduplicate(views);
		logViews("Releasing Views", stale);
		this.releaseViews(stale);
		if (stale.length === 0 && ViewsetsEqual(matching, this.views)) {
			// We can assume all views are ready.
			const attachedViews = await this.viewsAttachedWithConnectionPool(
				this.views,
			);
			logViews("Attached Views", attachedViews);
		} else {
			const readyViews = await this.viewsReady(matching);
			logViews("Ready Views", readyViews);
			const attachedViews =
				await this.viewsAttachedWithConnectionPool(readyViews);
			logViews("Attached Views", attachedViews);
			this.views = matching;
		}
		log("loading plugins");
		this.load();
		const now = moment.utc();
		log(`refresh completed in ${now.diff(queuedAt)}ms`, ctx);
		return true;
	}

	async refresh(context: string) {
		if (this.destroyed) return false;
		const log = curryLog(context, "warn");
		const queuedAt = moment.utc();
		this.refreshQueue.push(() => {
			return this._refreshViews(context, queuedAt);
		});
		if (this._activePromise !== null) {
			return false;
		}
		while (this.refreshQueue.length > 0) {
			if (this.destroyed) return false;
			if (this.refreshQueue.length > 2) {
				log("refreshQueue size:", this.refreshQueue.length);
			}
			const job = this.refreshQueue.pop()!;
			this.refreshQueue.length = 0;
			this._activePromise = job().finally(() => {
				this._activePromise = null;
			});
			await this._activePromise;
		}
		return true;
	}

	wipe() {
		this.extensions.length = 0;
		this.workspace.updateOptions();
	}

	load() {
		this.wipe();
		if (this.views.length > 0) {
			this.extensions.push([
				this._compartment.of(
					ConnectionManagerStateField.init(() => {
						return this;
					}),
				),
				// HSMEditorPlugin: Captures editor changes and forwards to HSM for CRDT sync.
				// Replaces legacy LiveEdit plugin's editor→CRDT functionality.
				HSMEditorPlugin,
				LiveNode,
				yRemoteSelectionsTheme,
				yRemoteSelections,
				InvalidLinkPlugin,
				conflictDecorationPlugin,
				conflictDecorationTheme,
			]);
			this.workspace.updateOptions();
		}
	}

	public destroy() {
		this.destroyed = true;
		this.releaseViews(this.views);
		this.offListeners.forEach((off) => off());
		this.offListeners.length = 0;
		this.metadataListeners.clear();
		this.metadataListeners = null as any;
		this.folderListeners.forEach((off) => off());
		this.folderListeners.clear();
		this.folderListeners = null as any;
		this.views.forEach((view) => view.destroy());
		this.views = [];
		this.wipe();
		this.sharedFolders = null as any;
		this.refreshQueue = null as any;
		this.networkStatus = null as any;
		this._activePromise = null as any;
		this.loginManager = null as any;
		this.app = null as any;
		this.workspace = null as any;
	}
}

export const ConnectionManagerStateField = StateField.define<
	LiveViewManager | undefined
>({
	create(state: EditorState) {
		return undefined;
	},
	update(currentManager, transaction) {
		return currentManager;
	},
});
