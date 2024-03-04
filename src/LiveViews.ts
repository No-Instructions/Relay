import { MarkdownView } from "obsidian";
import { Document } from "./Document";
import { SharedFolder, SharedFolders } from "./SharedFolder";
import { WorkspaceFacade } from "./obsidian-api/Workspace";
import { Compartment, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ConnectionStatusIcon } from "./ui/ConnectionStatusIcon";
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
import { ShareLinkPlugin } from "./ShareLinkPlugin";

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
	plugin: LiveCMPluginValue;
	shouldConnect: boolean;

	private _connectionStatusIcon: ConnectionStatusIcon;
	private _parent: LiveViewManager;
	private _offStatus: () => void;

	constructor(
		connectionManager: LiveViewManager,
		view: MarkdownView,
		document: Document,
		shouldConnect = true
	) {
		this._parent = connectionManager; // for debug
		this.view = view;
		this.document = document;
		this._connectionStatusIcon = new ConnectionStatusIcon(this);
		this.shouldConnect = shouldConnect;
	}

	toggleConnection() {
		this.shouldConnect = !this.shouldConnect;
		if (this.shouldConnect) {
			this.document.connect();
		} else {
			this.document.disconnect();
		}
	}

	public get ytext(): YText {
		return this.document.ytext;
	}

	attach(): Promise<LiveView> {
		return new Promise((resolve) => {
			return this.document.whenReady().then((doc) => {
				if (this.shouldConnect) {
					this.connect();
				}
				if (!this._offStatus) {
					doc.providerStatusSubscription((status) => {
						this._connectionStatusIcon.setState(
							doc.guid,
							status.status
						);
					}).then((sub) => {
						sub.on();
						this._offStatus = sub.off;
					});
				}
				resolve(this);
			});
		});
	}

	connect() {
		if (!this._connectionStatusIcon) {
			this._connectionStatusIcon = new ConnectionStatusIcon(this);
		}
		this.document.connect();
	}

	release() {
		// Called when a view is released from management
		if (this._offStatus) {
			this._offStatus();
		}
		this._connectionStatusIcon.destroy();
		this.document.disconnect();
	}
}

export class LiveViewManager {
	workspace: WorkspaceFacade;
	views: LiveView[];
	private _activePromise?: Promise<void> | null;
	private _stale: boolean;
	private _compartment: Compartment;
	private loginManager: LoginManager;
	sharedFolders: SharedFolders;
	extensions: Extension[];

	constructor(
		workspace: WorkspaceFacade,
		sharedFolders: SharedFolders,
		loginManager: LoginManager
	) {
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;
		this.views = [];
		this.extensions = [];
		this._compartment = new Compartment();
		this._activePromise = null;
		this._stale = false;
		this.loginManager = loginManager;

		this.views = this.getViews();

		this.sharedFolders.on(() => {
			this.refresh("[Shared Folders]");
		});

		this.refresh("Constructor");
	}
	loginBanner() {
		this._loginBanner(this.views);
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
				const doc = folder.getFile(viewFilePath, false);
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

	private async viewsAttached(views: LiveView[]): Promise<LiveView[]> {
		return await Promise.all(
			views.map(async (view) => {
				return view.attach();
			})
		);
	}

	private deduplicate(): [LiveView[], LiveView[]] {
		const views = this.getViews();
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

	async _refreshViews(context: string): Promise<void> {
		const ctx = `[ConnectionManager][${context}]`;
		const log = curryLog(ctx);
		log("Refresh");

		if (!this.loginManager.hasUser) {
			console.warn("no user");
			const views = this.getViews();
			this._loginBanner(views);
			return;
		}

		const readyFolders = await this.foldersReady();
		log("Ready Folders", readyFolders);

		const [matching, stale] = this.deduplicate();

		if (stale.length == 0 && ViewsetsEqual(matching, this.views)) {
			log("No work to do");
			const attachedViews = await this.viewsAttached(this.views);
			log("Attached Vies", attachedViews);
		} else {
			log("Releasing Views", stale);
			this.releaseViews(stale);
			const readyViews = await this.viewsReady(matching);
			log("Ready Views", readyViews);
			const attachedViews = await this.viewsAttached(readyViews);
			log("Attached Views", attachedViews);
		}
		this.views = matching;
		this.load();
	}

	async refresh(context: string): Promise<void> {
		const log = curryLog(context);
		if (this._activePromise) {
			this._stale = true;
			log("refresh views was already running");
			return;
		}
		this._activePromise = this._refreshViews(context);
		await this._activePromise;
		this._activePromise = null;
		if (this._stale) {
			this._stale = false;
			this.refresh(context);
		}
	}

	wipe() {
		this.extensions.length = 0;
		this.workspace.updateOptions();
	}

	load() {
		this.wipe();
		this.extensions.push([
			this._compartment.of(connectionManagerFacet.of(this)),
			LiveEdit,
			ShareLinkPlugin,
			yRemoteSelectionsTheme,
			yRemoteSelections,
		]);
		this.workspace.updateOptions();
	}
}
