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
import {
	yRemoteSelections,
	yRemoteSelectionsTheme,
} from "./y-codemirror.next/RemoteSelections";
import { InvalidLinkPlugin } from "./markdownView/InvalidLinkExtension";
import * as Differ from "./differ/differencesView";
import type { CanvasView } from "./CanvasView";
import { type Canvas } from "./Canvas";
import { CanvasPlugin } from "./CanvasPlugin";
import { LiveNode } from "./y-codemirror.next/LiveNodePlugin";
import { flags } from "./flagManager";
import { AwarenessViewPlugin } from "./AwarenessViewPlugin";
import { TextFileViewPlugin } from "./TextViewPlugin";

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

	setLoginIcon(): void {
		const viewHeaderElement =
			this.view.containerEl.querySelector(".view-header");
		const viewHeaderLeftElement = 
			this.view.containerEl.querySelector(".view-header-left");
		
		if (viewHeaderElement && viewHeaderLeftElement) {
			this.clearLoginButton();
			
			// Create login button element
			const loginButton = document.createElement("button");
			loginButton.className = "view-header-left system3-login-button";
			loginButton.textContent = "Login to enable Live edits";
			loginButton.setAttribute("aria-label", "Login to enable Live edits");
			loginButton.setAttribute("tabindex", "0");
			
			// Add click handler
			loginButton.addEventListener("click", async () => {
				await this.login();
			});
			
			// Insert after view-header-left
			viewHeaderLeftElement.insertAdjacentElement("afterend", loginButton);
		}
	}

	clearLoginButton() {
		const existingButton = this.view.containerEl.querySelector(".system3-login-button");
		if (existingButton) {
			existingButton.remove();
		}
	}

	attach(): Promise<S3View> {
		// Use header button approach on mobile for Obsidian >=1.11.0 to avoid banner positioning issues
		if (Platform.isMobile && requireApiVersion("1.11.0")) {
			this.setLoginIcon();
		} else {
			this.banner = new Banner(
				this.view,
				"Login to enable Live edits",
				async () => {
					return await this.login();
				},
			);
		}
		return Promise.resolve(this);
	}

	release() {
		this.banner?.destroy();
		this.clearLoginButton();
	}

	destroy() {
		this.release();
		this.banner?.destroy();
		this.banner = undefined;
		this.clearLoginButton();
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
				"You're offline -- click to reconnect",
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
		this.canvas.userLock = false;
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
		return this._tracking;
	}

	public set tracking(value: boolean) {
		const old = this._tracking;
		this._tracking = value;
		if (this._tracking !== old) {
			this.attach();
		}
	}

	public get ytext(): Y.Text {
		return this.document.ytext;
	}

	public get connectionManager(): LiveViewManager {
		return this._parent;
	}

	setMergeButton(): void {
		const viewHeaderElement =
			this.view.containerEl.querySelector(".view-header");
		const viewHeaderLeftElement = 
			this.view.containerEl.querySelector(".view-header-left");
		
		if (viewHeaderElement && viewHeaderLeftElement) {
			this.clearMergeButton();
			
			// Create merge button element
			const mergeButton = document.createElement("button");
			mergeButton.className = "view-header-left system3-merge-button";
			mergeButton.textContent = "Merge conflict";
			mergeButton.setAttribute("aria-label", "Merge conflict -- click to resolve");
			mergeButton.setAttribute("tabindex", "0");
			
			// Add click handler
			mergeButton.addEventListener("click", async () => {
				const diskBuffer = await this.document.diskBuffer();
				const stale = await this.document.checkStale();
				if (!stale) {
					this.clearMergeButton();
					return;
				}
				this._parent.openDiffView({
					file1: this.document,
					file2: diskBuffer,
					showMergeOption: true,
					onResolve: async () => {
						this.document.clearDiskBuffer();
						this.clearMergeButton();
						// Force view to sync to CRDT state after differ resolution
						if (
							this._plugin &&
							typeof this._plugin.syncViewToCRDT === "function"
						) {
							await this._plugin.syncViewToCRDT();
						}
					},
				});
			});
			
			// Insert after view-header-left
			viewHeaderLeftElement.insertAdjacentElement("afterend", mergeButton);
		}
	}

	clearMergeButton() {
		const existingButton = this.view.containerEl.querySelector(".system3-merge-button");
		if (existingButton) {
			existingButton.remove();
		}
	}

	mergeBanner(): () => void {
		// Use header button approach on mobile for Obsidian >=1.11.0 to avoid banner positioning issues
		if (Platform.isMobile && requireApiVersion("1.11.0")) {
			this.setMergeButton();
		} else {
			this._banner = new Banner(
				this.view,
				"Merge conflict -- click to resolve",
				async () => {
					const diskBuffer = await this.document.diskBuffer();
					const stale = await this.document.checkStale();
					if (!stale) {
						return true;
					}
					this._parent.openDiffView({
						file1: this.document,
						file2: diskBuffer,
						showMergeOption: true,
						onResolve: async () => {
							this.document.clearDiskBuffer();
							// Force view to sync to CRDT state after differ resolution
							if (
								this._plugin &&
								typeof this._plugin.syncViewToCRDT === "function"
							) {
								await this._plugin.syncViewToCRDT();
							}
						},
					});
					return true;
				},
			);
		}
		return () => {};
	}

	offlineBanner(): () => void {
		if (this.shouldConnect) {
			const banner = new Banner(
				this.view,
				"You're offline -- click to reconnect",
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
			return false;
		}
		const stale = await this.document.checkStale();
		if (stale && this.document._diskBuffer?.contents) {
			this.mergeBanner();
		} else {
			this._banner?.destroy();
			this._banner = undefined;
		}
		return stale;
	}

	attach(): Promise<this> {
		// can be called multiple times, whereas release is only ever called once
		this.document.userLock = true;

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

		// Save document if view was tracking changes
		if (this.tracking) {
			this.document.save();
		}

		// Remove the live editor class
		if (this.view instanceof MarkdownView) {
			this.view.containerEl.removeClass("relay-live-editor");
		}

		this._viewActions?.$destroy();
		this._viewActions = undefined;
		this._banner?.destroy();
		this._banner = undefined;
		this.clearMergeButton();
		if (this.offConnectionStatusSubscription) {
			this.offConnectionStatusSubscription();
			this.offConnectionStatusSubscription = undefined;
		}
		this._awarenessPlugin?.destroy();
		this._awarenessPlugin = undefined;
		this._plugin?.destroy();
		this._plugin = undefined;
		this.document.disconnect();
		this.document.userLock = false;
	}

	destroy() {
		this.release();
		this.clearViewActions();
		this.clearMergeButton();
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
			if (folder) {
				// Check if this canvas file should actually be treated as a Canvas
				const vpath = folder.getVirtualPath(viewFilePath);
				const meta = folder.syncStore.getMeta(vpath);
				
				// Only connect if it's actually a Canvas type in the sync store
				if (meta?.type === "canvas") {
					if (!this.loginManager.loggedIn) {
						const view = new LoggedOutView(this, canvasView, () => {
							return this.loginManager.openLoginPage();
						});
						views.push(view);
					} else if (folder.ready) {
						const doc = folder.proxy.getCanvas(viewFilePath);
						const view = new RelayCanvasView(this, canvasView, doc);
						views.push(view);
					} else {
						this.log(`Folder not ready, skipping views. folder=${folder.path}`);
					}
				} else {
					// File is a .canvas file but should be treated as SyncFile - don't connect
					this.log(`Skipping canvas view connection for ${viewFilePath} - sync store type is ${meta?.type || 'unknown'}`);
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
				LiveEdit,
				LiveNode,
				yRemoteSelectionsTheme,
				yRemoteSelections,
				InvalidLinkPlugin,
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
