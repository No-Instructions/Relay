import { MarkdownView, Platform } from "obsidian";
import { Document } from "./Document";
import { SharedFolder, SharedFolders } from "./SharedFolder";
import { WorkspaceFacade } from "./obsidian-api/Workspace";
import type { Extension } from "@codemirror/state";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import ViewActions from "src/components/ViewActions.svelte";
import { LiveCMPluginValue } from "./y-codemirror.next/LiveEditPlugin";
import {
	connectionManagerFacet,
	LiveEdit,
} from "./y-codemirror.next/LiveEditPlugin";
import {
	yRemoteSelections,
	yRemoteSelectionsTheme,
} from "./y-codemirror.next/RemoteSelections";
import { curryLog } from "./debug";
import { YText } from "yjs/dist/src/types/YText";
import { Banner } from "./ui/Banner";
import { LoginManager } from "./LoginManager";
import NetworkStatus from "./NetworkStatus";
import { promiseWithTimeout } from "./promiseUtils";
import type { ConnectionState } from "./HasProvider";
import { moment } from "obsidian";

const BACKGROUND_CONNECTIONS = 20;

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
	view: MarkdownView;
	plugin?: LiveCMPluginValue;
	release: () => void;
	attach: () => Promise<S3View>;
	document: Document | null;
}

export class LoggedOutView implements S3View {
	view: MarkdownView;
	plugin?: LiveCMPluginValue;
	login: () => Promise<boolean>;
	banner?: Banner;
	document = null;

	private _parent: LiveViewManager;

	constructor(
		connectionManager: LiveViewManager,
		view: MarkdownView,
		login: () => Promise<boolean>,
	) {
		this._parent = connectionManager; // for debug
		this.view = view;
		this.login = login;
	}

	attach() {
		this.banner = new Banner(
			this.view,
			"Login to enable Live edits",
			async () => {
				return await this.login();
			},
		);
		return Promise.resolve(this);
	}

	release() {
		this.banner?.destroy();
	}
}

export class LiveView implements S3View {
	view: MarkdownView;
	document: Document;
	plugin?: LiveCMPluginValue;
	shouldConnect: boolean;
	canConnect: boolean;

	private _viewActions?: ViewActions;
	private offConnectionStatusSubscription?: () => void;
	private _parent: LiveViewManager;

	constructor(
		connectionManager: LiveViewManager,
		view: MarkdownView,
		document: Document,
		shouldConnect = true,
		canConnect = true,
	) {
		this._parent = connectionManager; // for debug
		this.view = view;
		this.document = document;

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

	public get ytext(): YText {
		return this.document.ytext;
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
			const viewActions = this.view.containerEl.querySelectorAll(
				".system3-view-action",
			);
			if (!this._viewActions) {
				if (viewActions.length > 0) {
					viewActions.forEach((viewAction) => {
						viewAction.remove();
					});
				}
				if (this.offConnectionStatusSubscription) {
					this.offConnectionStatusSubscription();
				}
				this._viewActions = new ViewActions({
					target: viewActionsElement,
					anchor: viewActionsElement.firstChild as Element,
					props: {
						view: this,
						document: this.document,
						state: this.document.state,
					},
				});
				this.offConnectionStatusSubscription = this.document.subscribe(
					viewActionsElement,
					(state: ConnectionState) => {
						this._viewActions?.$set({
							view: this,
							document: this.document,
							state: state,
						});
					},
				);
			}
			this._viewActions.$set({
				view: this,
				document: this.document,
				state: this.document.state,
			});
		}
	}

	attach(): Promise<LiveView> {
		// can be called multiple times, whereas release is only ever called once
		this.setConnectionDot();
		return new Promise((resolve) => {
			return this.document
				.whenReady()
				.then((doc) => {
					if (
						this.shouldConnect &&
						this.canConnect &&
						this._parent.networkStatus.online
					) {
						this.connect();
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
		this._viewActions?.$destroy();
		this._viewActions = undefined;
		if (this.offConnectionStatusSubscription) {
			this.offConnectionStatusSubscription();
			this.offConnectionStatusSubscription = undefined;
		}
		this.document.disconnect();
	}
}

export class LiveViewManager {
	workspace: WorkspaceFacade;
	views: S3View[];
	private _activePromise?: Promise<boolean> | null;
	private _stale: string;
	private _compartment: Compartment;
	private loginManager: LoginManager;
	private offListeners: (() => void)[] = [];
	private folderListeners: Map<SharedFolder, () => void> = new Map();
	sharedFolders: SharedFolders;
	extensions: Extension[];
	networkStatus: NetworkStatus;
	refreshQueue: (() => Promise<boolean>)[];
	log: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;

	constructor(
		workspace: WorkspaceFacade,
		sharedFolders: SharedFolders,
		loginManager: LoginManager,
		networkStatus: NetworkStatus,
	) {
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;
		this.views = [];
		this.extensions = [];
		this._compartment = new Compartment();
		this._activePromise = null;
		this._stale = "";
		this.loginManager = loginManager;
		this.networkStatus = networkStatus;
		this.refreshQueue = [];

		this.log = curryLog("[LiveViews]", "log");
		this.warn = curryLog("[LiveViews]", "warn");

		this.offListeners.push(
			this.loginManager.on(() => {
				this.refresh("[LoginManager]");
			}),
		);

		const folderSub = (folder: SharedFolder) => {
			if (!folder.ready) {
				folder
					.whenReady()
					.then(() => {
						this.refresh("[Shared Folder Ready]");
					})
					.catch((_) => {
						this.views.forEach((view) => {
							if (view.document?.sharedFolder === folder) {
								(view as LiveView).offlineBanner();
							}
						});
					});
			}

			return folder.docset.on(() => {
				this.refresh("[Docset]");
			});
		};

		this.offListeners.push(
			this.sharedFolders.on(() => {
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
		this.workspace.iterateMarkdownViews((markdownView) => {
			// Check if the view is displaying a file
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		if ([...folders].length == 0) {
			return [];
		}
		return [...folders];
	}

	private async foldersReady(): Promise<SharedFolder[]> {
		const folders: Set<SharedFolder> = new Set<SharedFolder>();
		this.workspace.iterateMarkdownViews((markdownView) => {
			// Check if the view is displaying a file
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		if ([...folders].length == 0) {
			return [];
		}

		const readyFolders = [...folders].map((folder) => folder.whenReady());
		return Promise.all(readyFolders);
	}

	private getViews(): S3View[] {
		const views: S3View[] = [];
		this.workspace.iterateMarkdownViews((markdownView) => {
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				if (!this.loginManager.loggedIn) {
					const view = new LoggedOutView(this, markdownView, () => {
						return this.loginManager.openLoginPage();
					});
					views.push(view);
				} else {
					const doc = folder.getFile(viewFilePath, true, true, true);
					const view = new LiveView(this, markdownView, doc);
					views.push(view);
				}
			}
		});
		return views;
	}

	findView(cmEditor: EditorView): S3View | undefined {
		return this.views.find((view) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const editor = view.view.editor as any;
			const cm = editor.cm as EditorView;
			return cm === cmEditor;
		});
	}

	private async viewsReady(views: S3View[]): Promise<LiveView[]> {
		// XXX yeesh
		return await Promise.all(
			views
				.filter((view) => view instanceof LiveView)
				.map(async (view) =>
					(view as LiveView).document.whenReady().then((_) => view as LiveView),
				),
		);
	}

	private async viewsAttachedWithConnectionPool(
		views: S3View[],
		backgroundConnections: number = BACKGROUND_CONNECTIONS,
	): Promise<S3View[]> {
		const activeView =
			this.workspace.workspace.getActiveViewOfType<MarkdownView>(MarkdownView);

		let attemptedConnections = 0;

		for (const view of views) {
			if (view instanceof LiveView) {
				if (view.view === activeView) {
					view.canConnect = true;
				} else {
					view.canConnect = attemptedConnections < backgroundConnections;
					attemptedConnections++;
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
		const log = curryLog(ctx, "warn");
		log("Refresh");

		await this.foldersReady();

		let views: S3View[] = [];
		try {
			views = this.getViews();
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
			log("Releasing Views", this.views);
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
		log("Releasing Views", stale);
		this.releaseViews(stale);
		if (stale.length === 0 && ViewsetsEqual(matching, this.views)) {
			// We can assume all views are ready.
			const attachedViews = await this.viewsAttachedWithConnectionPool(
				this.views,
			);
			log("Attached Views", attachedViews);
		} else {
			const readyViews = await this.viewsReady(matching);
			log("Ready Views", readyViews);
			const attachedViews =
				await this.viewsAttachedWithConnectionPool(readyViews);
			log("Attached Views", attachedViews);
			this.views = matching;
		}
		log("loading plugins");
		this.load();
		const now = moment.utc();
		log(`refresh completed in ${now.diff(queuedAt)}ms`, ctx);
		return true;
	}

	async refresh(context: string, timeout = 3000) {
		const log = curryLog(context, "warn");
		const queuedAt = moment.utc();
		this.refreshQueue.push(() => {
			return this._refreshViews(context, queuedAt);
		});
		if (this._activePromise !== null) {
			return false;
		}
		while (this.refreshQueue.length > 0) {
			if (this.refreshQueue.length > 2) {
				log("refreshQueue size:", this.refreshQueue.length);
				this.refreshQueue.slice(-2);
			}
			if (Platform.isIosApp) {
				this._activePromise = this.refreshQueue.pop()!().finally(() => {
					this._activePromise = null;
				});
				await this._activePromise;
			} else {
				this._activePromise = promiseWithTimeout<boolean>(
					this.refreshQueue.pop()!(),
					timeout,
				)
					.catch((e) => {
						this.warn(
							`[System 3][Relay][Live Views] refresh views timed out... timeout=${timeout}`,
							e,
						);
						this._activePromise = null;
						return false;
					})
					.finally(() => {
						this._activePromise = null;
					});
				await this._activePromise;
			}
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
				this._compartment.of(connectionManagerFacet.of(this)),
				LiveEdit,
				yRemoteSelectionsTheme,
				yRemoteSelections,
			]);
			this.workspace.updateOptions();
		}
	}

	public destroy() {
		this.releaseViews(this.views);
		this.offListeners.forEach((off) => off());
		this.offListeners.length = 0;
		this.folderListeners.forEach((off) => off());
		this.folderListeners.clear();
		this.wipe();
	}
}
