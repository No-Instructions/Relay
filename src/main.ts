"use strict";

import { Plugin, TFolder, Notice, MarkdownView, TFile } from "obsidian";

import { SharedFolder, SharedFolderSettings } from "./SharedFolder";
import { LiveViewManager } from "./LiveViews";

import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { VaultFacade } from "./obsidian-api/Vault";
import { WorkspaceFacade } from "./obsidian-api/Workspace";
import { SharedFolders } from "./SharedFolder";
import { FolderNavIcon } from "./ui/FolderNav";
import { FolderMenu } from "./ui/FolderMenu";
import { LiveSettingsTab } from "./ui/SettingsTab";
import { LoginManager } from "./LoginManager";
import { curryLog } from "./debug";
import { around } from "monkey-around";

interface LiveSettings {
	sharedFolders: SharedFolderSettings[];
}

const DEFAULT_SETTINGS: LiveSettings = {
	sharedFolders: [],
};

export default class Live extends Plugin {
	settings: LiveSettings;
	sharedFolders: SharedFolders;
	vault: VaultFacade;
	loginManager: LoginManager;
	_extensions: [];
	private _liveViews: LiveViewManager;

	async onload() {
		console.log("[Obsidian Live] Loading Plugin");
		await this.loadSettings();
		this.loginManager = new LoginManager();

		if (!this.loginManager.setup()) {
			new Notice("Please login to Obsidian Live");
		}
		this.vault = new VaultFacade(this.app);
		this.sharedFolders = this.loadSharedFolders(
			this.settings.sharedFolders
		); // Loading shared folders also sanitizes them...
		this.saveSettings();

		// install hooks for logout/login
		this.loginManager.on(() => {
			if (this.loginManager.hasUser) {
				this._onLogin();
			} else {
				this._onLogout();
			}
		});

		const workspace = new WorkspaceFacade(this.app.workspace);
		this._liveViews = new LiveViewManager(
			workspace,
			this.sharedFolders,
			this.loginManager
		);
		// NOTE: Extensions list should be loaded once and then mutated.
		// this.app.workspace.updateOptions(); must be called to apply changes.
		this.registerEditorExtension(this._liveViews.extensions);

		this.setup();
	}

	private loadSharedFolders(
		sharedFolderSettings: SharedFolderSettings[]
	): SharedFolders {
		const sharedFolders = new SharedFolders(
			this._createSharedFolder.bind(this)
		);
		sharedFolderSettings.forEach(
			(sharedFolderSetting: SharedFolderSettings) => {
				if (
					!existsSync(this.vault.fullPath(sharedFolderSetting.path))
				) {
					console.warn(
						`[Obsidian Live][Shared Folder]: Invalid settings, ${sharedFolderSetting.path} does not exist`
					);
					return;
				}
				const folder = this._createSharedFolder(
					sharedFolderSetting.path,
					sharedFolderSetting.guid
				);
				sharedFolders.add(folder);
			}
		);
		sharedFolders.on(() => {
			this.saveSettings();
		});
		return sharedFolders;
	}

	private _createSharedFolder(path: string, guid: string): SharedFolder {
		const _guid = guid || randomUUID();
		const folder = new SharedFolder(
			_guid,
			path,
			this.loginManager,
			this.vault
		);
		return folder;
	}

	private _onLogout() {
		this.saveSettings();
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
		const folderNavIcon = new FolderNavIcon(
			this.vault,
			this.app.workspace,
			this.sharedFolders
		);
		this.registerEvent(folderNavIcon.register());

		const folderMenu = new FolderMenu(this.app, this.sharedFolders);
		this.registerEvent(folderMenu.register());

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

		const vaultLog = curryLog("[Live][Vault]");

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				vaultLog("create", file);
				// NOTE: this is called on every file at startup...
				if (file instanceof TFolder) {
					return;
				}
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					folder.whenReady().then((folder) => {
						folder.getFile(file.path, true);
					});
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				vaultLog("delete", file);
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
					folder.whenReady().then((folder) => {
						folder.deleteFile(file.path);
					});
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				vaultLog("rename", file, oldPath);
				// TODO: this is broken when moving files between two shared folders...
				// TODO: this is broken when renaming a shared folder
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
				const folder =
					this.sharedFolders.lookup(oldPath) ||
					this.sharedFolders.lookup(file.path);
				if (folder) {
					folder.whenReady().then((folder) => {
						folder.renameFile(file.path, oldPath);
					});
				}
				this._liveViews.refresh("rename");
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				vaultLog("modify", file);
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					this.app.metadataCache.trigger("resolve", file);
				}
			})
		);

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;

		const patchOnUnloadFile = around(MarkdownView.prototype, {
			onUnloadFile(old) {
				return function (file) {
					plugin._liveViews.refresh("unload");
					return old.call(this, file);
				};
			},
		});

		this.registerEvent(patchOnUnloadFile);
	}

	onunload() {
		this.sharedFolders.forEach((sharedFolder) => {
			sharedFolder.destroy();
		});
		console.log("[Obsidian Live]: Unloading Plugin");
		this.saveSettings();
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
