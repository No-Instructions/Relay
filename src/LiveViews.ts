import { MarkdownView, type WorkspaceLeaf } from "obsidian";
import { Document } from "./Document";
import { SharedFolder, SharedFolders } from "./SharedFolder";
import { WorkspaceFacade } from "./obsidian-api/Workspace";
import type { Extension } from "@codemirror/state";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import ConnectionStatusIcon from "src/components/ConnectionStatusIcon.svelte";
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
import moment from "moment";

const BACKGROUND_CONNECTIONS = 20;
const MAX_TIMEOUT = 10000;
const TIMEOUT_INCREASE = 3000;

function ViewsetsEqual(vs1: LiveView[], vs2: LiveView[]): boolean {
	if (vs1.length !== vs2.length) {
		return false;
	}

	for (let i = 0; i < vs1.length; i++) {
		if (vs1[i].view.file?.path !== vs2[i].view.file?.path) {
			return false;
		}
		if (vs1[i].document.path !== vs2[i].document.path) {
			return false;
		}
	}
	return true;
}

export class LiveView {
	view: MarkdownView;
	document: Document;
	plugin?: LiveCMPluginValue;
	shouldConnect: boolean;
	canConnect: boolean;

	private _connectionStatusIcon?: ConnectionStatusIcon;
	private offConnectionStatusSubscription?: () => void;
	private _parent: LiveViewManager;

	constructor(
		connectionManager: LiveViewManager,
		view: MarkdownView,
		document: Document,
		shouldConnect = true,
		canConnect = true
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
				() => {
					this._parent.networkStatus.checkStatus();
					this.connect();
				}
			);
			this.document.onceConnected().then(() => {
				banner.destroy();
			});
			return () => {
				banner.destroy();
			};
		}
		return () => {};
	}

	setConnectionDot(): void {
		const viewActionsElement =
			this.view.containerEl.querySelector(".view-actions");
		if (viewActionsElement && viewActionsElement.firstChild) {
			const connectionStatusIcon = this.view.containerEl.querySelector(
				".connection-status-icon"
			);
			if (!this._connectionStatusIcon) {
				if (connectionStatusIcon) {
					connectionStatusIcon.remove();
				}
				this._connectionStatusIcon = new ConnectionStatusIcon({
					target: viewActionsElement,
					anchor: viewActionsElement.firstChild as Element,
					props: {
						view: this,
						state: this.document.state,
					},
				});
			}
			this._connectionStatusIcon.$set({
				view: this,
				state: this.document.state,
			});
			this.offConnectionStatusSubscription = this.document.subscribe(
				connectionStatusIcon,
				(state: ConnectionState) => {
					this._connectionStatusIcon?.$set({
						view: this,
						state: state,
					});
				}
			);
		}
	}

	attach(): Promise<LiveView> {
		// can be called multiple times, whereas release is only ever called once
		this.setConnectionDot();
		return new Promise((resolve) => {
			return this.document
				.whenReady()
				.then((doc) => {
					if (this.shouldConnect && this.canConnect) {
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
		if (this._parent.networkStatus.online) {
			this.document.connect();
		} else {
			this.document.disconnect();
		}
	}

	release() {
		// Called when a view is released from management
		this._connectionStatusIcon?.$destroy();
		this._connectionStatusIcon = undefined;
		if (this.offConnectionStatusSubscription) {
			this.offConnectionStatusSubscription();
			this.offConnectionStatusSubscription = undefined;
		}
		this.document.disconnect();
	}
}

export class LiveViewManager {
	workspace: WorkspaceFacade;
	views: LiveView[];
	private _activePromise?: Promise<boolean> | null;
	private _stale: string;
	private _compartment: Compartment;
	private loginManager: LoginManager;
	sharedFolders: SharedFolders;
	extensions: Extension[];
	networkStatus: NetworkStatus;
	refreshQueue: (() => Promise<boolean>)[];

	constructor(
		workspace: WorkspaceFacade,
		sharedFolders: SharedFolders,
		loginManager: LoginManager,
		networkStatus: NetworkStatus
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

		this.foldersReady().then((folders) => {
			this.views = this.getViews();
			this.refresh("[Constructor]");
		});

		this.sharedFolders.forEach((folder) => {
			folder.docset.on(() => {
				this.refresh("[Docset]");
			});
		});

		this.sharedFolders.on(() => {
			this.refresh("[Shared Folders]");

			this.sharedFolders.forEach((folder) => {
				if (!folder.ready) {
					folder
						.whenReady()
						.then(() => {
							this.refresh("[Shared Folder Ready]");
						})
						.catch((_) => {
							this.views.forEach((view) => {
								if (view.document.sharedFolder === folder) {
									view.offlineBanner();
								}
							});
						});
				}
			});
		});
	}

	loginBanner() {
		this._loginBanner(this.views);
	}

	goOffline() {
		this.views.forEach((view) => {
			view.document.disconnect();
			const clear = view.offlineBanner();
			this.networkStatus.onceOnline(clear);
		});
	}

	goOnline() {
		const folders = this.findFolders();
		folders.forEach((folder: SharedFolder) => {
			folder.connect();
		});
		this.views.forEach((view) => {
			view.document.getProviderToken();
		});
		this.viewsAttachedWithConnectionPool(this.views);
	}

	_loginBanner(views: LiveView[]) {
		if (!this.loginManager.hasUser) {
			// XXX do better kid
			// we are logged out
			views.forEach((view) => {
				const banner = new Banner(
					view.view,
					"Login to enable Live edits",
					() => {
						this.loginManager.login();
					}
				);
				this.loginManager.on(() => {
					if (this.loginManager.hasUser) {
						banner.destroy();
					}
				});
			});
		}
	}

	private releaseViews(views: LiveView[]) {
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
		return await Promise.all(readyFolders);
	}

	private getViews(): LiveView[] {
		const views: LiveView[] = [];
		this.workspace.iterateMarkdownViews((markdownView) => {
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				const doc = folder.getFile(viewFilePath, false, false);
				const view = new LiveView(this, markdownView, doc);
				views.push(view);
			}
		});
		return views;
	}

	findView(cmEditor: EditorView): LiveView | undefined {
		return this.views.find((view) => {
			const editor = view.view.editor as any;
			const cm = editor.cm as EditorView;
			return cm === cmEditor;
		});
	}

	private async viewsReady(views: LiveView[]): Promise<LiveView[]> {
		return await Promise.all(
			views.map(async (view) =>
				view.document.whenReady().then((_) => view)
			)
		);
	}

	private async viewsAttachedWithConnectionPool(
		views: LiveView[],
		backgroundConnections: number = BACKGROUND_CONNECTIONS
	): Promise<LiveView[]> {
		const activeView =
			this.workspace.workspace.getActiveViewOfType<MarkdownView>(
				MarkdownView
			);

		let connectionPool = backgroundConnections;
		let attemptedConnections = 0;

		for (const view of views) {
			if (view.view === activeView) {
				view.canConnect = true;
			} else {
				view.canConnect = attemptedConnections < connectionPool;
				attemptedConnections++;
			}
		}

		if (attemptedConnections > connectionPool) {
			console.warn(
				`connection pool (max ${connectionPool}): rejected connections for ${
					attemptedConnections - connectionPool
				} views`
			);
		}

		return this.viewsAttached(views);
	}

	private async viewsAttached(views: LiveView[]): Promise<LiveView[]> {
		return await Promise.all(
			views.map(async (view) => {
				return view.attach();
			})
		);
	}

	private deduplicate(views: LiveView[]): [LiveView[], LiveView[]] {
		const stale: LiveView[] = [];
		const matching: LiveView[] = [];
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
		queuedAt: moment.Moment
	): Promise<boolean> {
		const ctx = `[LiveViews][${context}]`;
		const log = curryLog(ctx);
		log("Refresh");

		let views: LiveView[];
		try {
			views = this.getViews();
		} catch (e) {
			console.warn("error getting views", e);
			return false;
		}
		const activeDocumentFolders = this.findFolders();
		if (activeDocumentFolders.length === 0 && views.length === 0) {
			if (this.extensions.length !== 0) {
				console.warn("unexpected plugins loaded");
				this.wipe();
			}
			log("no live views open");
			log("Releasing Views", this.views);
			this.releaseViews(this.views);
			this.views = [];
			return true; // no live views open
		}

		if (!this.loginManager.hasUser) {
			console.warn("no user");
			this._loginBanner(views);
			return false;
		}

		activeDocumentFolders.forEach((folder) => {
			folder.connect();
		});

		const [matching, stale] = this.deduplicate(views);
		log("Releasing Views", stale);
		this.releaseViews(stale);
		if (stale.length === 0 && ViewsetsEqual(matching, this.views)) {
			// We can assume all views are ready.
			const attachedViews = await this.viewsAttachedWithConnectionPool(
				this.views
			);
			log("Attached Views", attachedViews);
		} else {
			const readyViews = await this.viewsReady(matching);
			log("Ready Views", readyViews);
			const attachedViews = await this.viewsAttachedWithConnectionPool(
				readyViews
			);
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
		const queuedAt = moment.utc();
		this.refreshQueue.push(() => {
			return this._refreshViews(context, queuedAt);
		});
		if (this._activePromise !== null) {
			return false;
		}
		while (this.refreshQueue.length > 0) {
			if (this.refreshQueue.length > 2) {
				this.refreshQueue.slice(-2);
			}
			this._activePromise = promiseWithTimeout<boolean>(
				this.refreshQueue.pop()!(),
				timeout
			)
				.catch((e) => {
					console.warn(
						`refresh views timed out... timeout=${timeout}`,
						e
					);
					return false;
				})
				.finally(() => {
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
		this.wipe();
	}
}
