"use strict";

import { Plugin, TFolder, Notice, MarkdownView } from "obsidian";
import { Platform } from "obsidian";
import { SharedFolder } from "./SharedFolder";
import type { SharedFolderSettings } from "./SharedFolder";
import { LiveViewManager } from "./LiveViews";

import { VaultFacade } from "./obsidian-api/Vault";
import { WorkspaceFacade } from "./obsidian-api/Workspace";
import { SharedFolders } from "./SharedFolder";
import { FolderNavigationDecorations } from "./ui/FolderNav";
import { LiveSettingsTab } from "./ui/SettingsTab";
import { LoginManager } from "./LoginManager";
import { curryLog, toast } from "./debug";
import { around } from "monkey-around";
import { LiveTokenStore } from "./LiveTokenStore";
import NetworkStatus from "./NetworkStatus";
import { ObsidianLiveException } from "./Exceptions";
import { FileManagerFacade } from "./obsidian-api/FileManager";
import { RelayManager } from "./RelayManager";

interface LiveSettings {
	sharedFolders: SharedFolderSettings[];
	showDocumentStatus: boolean;
	debugging: boolean;
}

const DEFAULT_SETTINGS: LiveSettings = {
	sharedFolders: [],
	showDocumentStatus: false,
	debugging: false,
};

declare const HEALTH_URL: string;

export default class Live extends Plugin {
	settings!: LiveSettings;
	sharedFolders!: SharedFolders;
	vault!: VaultFacade;
	loginManager!: LoginManager;
	fileManager!: FileManagerFacade;
	tokenStore!: LiveTokenStore;
	networkStatus!: NetworkStatus;
	folderNavDecorations!: FolderNavigationDecorations;
	_offSaveSettings!: () => void;
	relayManager!: RelayManager;
	_extensions!: [];
	log!: (message: string) => void;
	private _liveViews!: LiveViewManager;

	async onload() {
		console.log("[System 3][Relay] Loading Plugin");
		this.log = curryLog("[System 3][Relay]");
		await this.loadSettings();
		this.vault = new VaultFacade(this.app);
		this.loginManager = new LoginManager();
		this.fileManager = new FileManagerFacade(this.app);
		const vaultName = this.vault.getName();
		this.tokenStore = new LiveTokenStore(this.loginManager, vaultName, 3);
		this.networkStatus = new NetworkStatus(HEALTH_URL);

		if (this.settings.debugging) {
			this.addCommand({
				id: "toggle-emulate-mobile",
				name: "Mobile emulation toggle",
				//@ts-expect-error
				callback: () => this.app.emulateMobile(!Platform.isMobile),
			});
		}

		if (!this.loginManager.setup()) {
			new Notice("Please sign in to use Relay");
		}

		this.app.workspace.onLayoutReady(() => {
			this.sharedFolders = this.loadSharedFolders(
				this.settings.sharedFolders
			); // Loading shared folders also sanitizes them...
			this.saveSettings();

			// install hooks for logout/login
			this.loginManager.on(() => {
				if (this.loginManager.loggedIn) {
					this._onLogin();
				} else {
					this._onLogout();
				}
			});
			this.relayManager = new RelayManager(this.sharedFolders);

			const workspace = new WorkspaceFacade(this.app.workspace);
			this._liveViews = new LiveViewManager(
				workspace,
				this.sharedFolders,
				this.loginManager,
				this.networkStatus
			);

			// NOTE: Extensions list should be loaded once and then mutated.
			// this.app.workspace.updateOptions(); must be called to apply changes.
			this.registerEditorExtension(this._liveViews.extensions);

			this.tokenStore.start();
			this.networkStatus.addEventListener("offline", () => {
				this.tokenStore.stop();
				this.sharedFolders.forEach((folder) => folder.disconnect());
				this._liveViews.goOffline();
			});
			this.networkStatus.addEventListener("online", () => {
				this.tokenStore.start();
				this._liveViews.goOnline();
			});
			this.networkStatus.checkStatus();

			this.setup();
		});
	}

	private loadSharedFolders(
		sharedFolderSettings: SharedFolderSettings[]
	): SharedFolders {
		const sharedFolders = new SharedFolders(
			this._createSharedFolder.bind(this)
		);
		sharedFolderSettings.forEach(
			(sharedFolderSetting: SharedFolderSettings) => {
				const tFolder = this.vault.getFolderByPath(
					sharedFolderSetting.path
				);
				if (!tFolder) {
					console.warn(
						`[System 3][Relay][Shared Folder]: Invalid settings, ${sharedFolderSetting.path} does not exist`
					);
					return;
				}
				sharedFolders.new(
					sharedFolderSetting.path,
					sharedFolderSetting.guid
				);
			}
		);
		const saveSettingsHook = () => {
			this.saveSettings();
		};
		sharedFolders.on(saveSettingsHook);
		this._offSaveSettings = () => {
			sharedFolders.off(saveSettingsHook);
		};
		return sharedFolders;
	}

	private async _createSharedFolder(
		path: string,
		guid: string
	): Promise<SharedFolder> {
		const folder = new SharedFolder(
			guid,
			path,
			this.loginManager,
			this.vault,
			this.fileManager,
			this.tokenStore
		);
		return folder;
	}

	private _onLogout() {
		this.saveSettings();
		this.tokenStore?.clear();
		this._liveViews.refresh("logout");
	}

	private _onLogin() {
		this.saveSettings();
		this.sharedFolders = this.loadSharedFolders(
			this.settings.sharedFolders
		); // Loading shared folders also sanitizes them...
		this.saveSettings();
		this._liveViews.refresh("login");
	}

	setup() {
		this.folderNavDecorations = new FolderNavigationDecorations(
			this.vault,
			this.app.workspace,
			this.sharedFolders,
			this.settings.showDocumentStatus
		);
		this.folderNavDecorations.refresh();

		this.addSettingTab(new LiveSettingsTab(this.app, this));

		const workspaceLog = curryLog("[Live][Workspace]");

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				workspaceLog("file-open");
				plugin._liveViews.refresh("file-open");
			})
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				workspaceLog("layout-change");
				this._liveViews.refresh("layout-change");
			})
		);

		const vaultLog = curryLog("[System 3][Relay][Vault]");

		const handleErrorEvent = (event: ErrorEvent) => {
			const error = event.error;
			if (error instanceof ObsidianLiveException) {
				toast(error);
			}
			//event.preventDefault();
		};

		const errorListener = (event: ErrorEvent) => handleErrorEvent(event);
		window.addEventListener("error", errorListener, true);
		this.register(() =>
			window.removeEventListener("error", errorListener, true)
		);

		const handlePromiseRejection = (event: PromiseRejectionEvent): void => {
			if (event.reason instanceof ObsidianLiveException) {
				toast(event.reason);
			}
			//event.preventDefault();
		};
		const rejectionListener = (event: PromiseRejectionEvent) =>
			handlePromiseRejection(event);
		window.addEventListener("unhandledrejection", rejectionListener, true);
		this.register(() =>
			window.removeEventListener(
				"unhandledrejection",
				rejectionListener,
				true
			)
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				// NOTE: this is called on every file at startup...
				if (file instanceof TFolder) {
					return;
				}
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					folder.whenReady().then((folder) => {
						folder.getFile(file.path, true, true);
					});
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFolder) {
					const folder = this.sharedFolders.find(
						(folder) => folder.path === file.path
					);
					if (folder) {
						this.sharedFolders.delete(folder);
					}
					return;
				}
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					vaultLog("Delete", file);
					folder.whenReady().then((folder) => {
						folder.deleteFile(file.path);
					});
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				// TODO this doesn't work for empty folders.
				if (file instanceof TFolder) {
					const sharedFolder = this.sharedFolders.find((folder) => {
						return folder.path == oldPath;
					});
					if (sharedFolder) {
						sharedFolder.path = file.path;
						this.sharedFolders.update();
					}
					return;
				}
				const fromFolder = this.sharedFolders.lookup(oldPath);
				const toFolder = this.sharedFolders.lookup(file.path);
				const folder = fromFolder || toFolder;
				if (fromFolder && toFolder) {
					// between two shared folders
					vaultLog("Rename", file, oldPath);
					fromFolder.renameFile(file.path, oldPath);
					toFolder.renameFile(file.path, oldPath);
					this._liveViews.refresh("rename");
				} else if (folder) {
					vaultLog("Rename", file, oldPath);
					folder.renameFile(file.path, oldPath);
					this._liveViews.refresh("rename");
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					vaultLog("Modify", file);
					this.app.metadataCache.trigger("resolve", file);
				}
			})
		);

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;

		const patchOnUnloadFile = around(MarkdownView.prototype, {
			// When this is called, the active editors haven't yet updated.
			onUnloadFile(old) {
				return function (file) {
					plugin._liveViews.wipe();
					// @ts-ignore
					return old.call(this, file);
				};
			},
		});
		this.register(patchOnUnloadFile);
	}

	onunload() {
		console.log("[System 3][Relay]: Unloading Plugin");
		// We want to unload the visual components but not the data
		if (this._offSaveSettings) {
			this._offSaveSettings();
			this.sharedFolders.destroy();
		}

		this.folderNavDecorations?.destroy();

		this.tokenStore?.stop();
		this.tokenStore?.clearState();

		this.relayManager.destroy();

		this.networkStatus?.stop();
		this._liveViews?.destroy();
	}

	onExternalSettingsChange() {
		this.onunload();
		this.onload();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		this.settings.sharedFolders = this.sharedFolders.toSettings();
		await this.saveData(this.settings);
	}
}
