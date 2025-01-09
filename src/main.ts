"use strict";

import {
	TFolder,
	Notice,
	MarkdownView,
	normalizePath,
	MetadataCache,
	TFile,
	Vault,
	FileManager,
} from "obsidian";
import { Platform } from "obsidian";
import { relative } from "path-browserify";
import { SharedFolder } from "./SharedFolder";
import type { SharedFolderSettings } from "./SharedFolder";
import { LiveViewManager } from "./LiveViews";

import { SharedFolders } from "./SharedFolder";
import { FolderNavigationDecorations } from "./ui/FolderNav";
import { LiveSettingsTab } from "./ui/SettingsTab";
import { LoginManager } from "./LoginManager";
import {
	curryLog,
	setDebugging,
	RelayInstances,
	initializeLogger,
	flushLogs,
	createToast,
} from "./debug";
import { around } from "monkey-around";
import { LiveTokenStore } from "./LiveTokenStore";
import NetworkStatus from "./NetworkStatus";
import { RelayException } from "./Exceptions";
import { RelayManager } from "./RelayManager";
import { DefaultTimeProvider, type TimeProvider } from "./TimeProvider";
import { auditTeardown } from "./observable/Observable";
import { updateYDocFromDiskBuffer } from "./BackgroundSync";
import { Plugin } from "obsidian";

import {
	DifferencesView,
	VIEW_TYPE_DIFFERENCES,
} from "./differ/differencesView";
import { FeatureFlagDefaults, flag, type FeatureFlags } from "./flags";
import { FeatureFlagManager, withFlag } from "./flagManager";
import { PostOffice } from "./observable/Postie";
import { BackgroundSync } from "./BackgroundSync";
import { FeatureFlagToggleModal } from "./ui/FeatureFlagModal";
import { DebugModal } from "./ui/DebugModal";
import { NamespacedSettings, Settings } from "./SettingsStorage";
import { ObsidianFileAdapter, ObsidianNotifier } from "./debugObsididan";
import { URLSearchParams } from "url";

interface DebugSettings {
	debugging: boolean;
}

const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
	debugging: false,
};

interface RelaySettings extends FeatureFlags, DebugSettings {
	sharedFolders: SharedFolderSettings[];
}

const DEFAULT_SETTINGS: RelaySettings = {
	sharedFolders: [],
	...FeatureFlagDefaults,
	...DEFAULT_DEBUG_SETTINGS,
};

declare const HEALTH_URL: string;
declare const API_URL: string;
declare const GIT_TAG: string;

export default class Live extends Plugin {
	sharedFolders!: SharedFolders;
	vault!: Vault;
	notifier!: ObsidianNotifier;
	toast!: (error: Error) => Error;
	loginManager!: LoginManager;
	timeProvider!: TimeProvider;
	fileManager!: FileManager;
	tokenStore!: LiveTokenStore;
	networkStatus!: NetworkStatus;
	backgroundSync!: BackgroundSync;
	folderNavDecorations!: FolderNavigationDecorations;
	relayManager!: RelayManager;
	settingsTab!: LiveSettingsTab;
	settings!: Settings<RelaySettings>;
	private featureSettings!: NamespacedSettings<FeatureFlags>;
	private debugSettings!: NamespacedSettings<DebugSettings>;
	private folderSettings!: NamespacedSettings<SharedFolderSettings[]>;
	log!: (message: string, ...args: unknown[]) => void;
	warn!: (message: string, ...args: unknown[]) => void;
	private _liveViews!: LiveViewManager;
	fileDiffMergeWarningKey = "file-diff-merge-warning";
	version = GIT_TAG;

	enableDebugging(save?: boolean) {
		setDebugging(true);
		console.warn("RelayInstances", RelayInstances);
		if (save) {
			this.debugSettings.update((settings) => ({
				...settings,
				debugging: true,
			}));
		}
	}

	disableDebugging(save?: boolean) {
		setDebugging(false);
		if (save) {
			this.debugSettings.update((settings) => ({
				...settings,
				debugging: false,
			}));
		}
	}

	toggleDebugging(save?: boolean): boolean {
		const setTo = !this.debugSettings.get().debugging;
		setDebugging(setTo);
		if (save) {
			this.debugSettings.update((settings) => ({
				...settings,
				debugging: setTo,
			}));
		}
		return setTo;
	}

	buildApiUrl(path: string) {
		return API_URL + path;
	}
	async onload() {
		RelayInstances.set(this, "plugin");
		this.timeProvider = new DefaultTimeProvider();
		this.register(() => {
			this.timeProvider.destroy();
		});

		initializeLogger(
			new ObsidianFileAdapter(this.app.vault),
			this.timeProvider,
			".obsidian/plugins/system3-relay/relay.log",
			{
				maxFileSize: 5 * 1024 * 1024, // 5MB
				maxBackups: 3,
				disableConsole: false, // Disable console logging
			},
		);
		this.notifier = new ObsidianNotifier();
		this.toast = createToast(this.notifier);

		this.log = curryLog("[System 3][Relay]", "log");
		this.warn = curryLog("[System 3][Relay]", "warn");

		this.settings = new Settings(this, DEFAULT_SETTINGS);
		await this.settings.load();

		this.featureSettings = new NamespacedSettings(this.settings, "(enable*)");
		this.debugSettings = new NamespacedSettings(this.settings, "(debugging)");
		this.folderSettings = new NamespacedSettings(
			this.settings,
			"sharedFolders",
		);

		const flagManager = FeatureFlagManager.getInstance();
		flagManager.setSettings(this.featureSettings);

		this.addRibbonIcon("satellite", "Relay", () => {
			this.openSettings();
		});

		this.debugSettings.subscribe((settings) => {
			if (settings.debugging) {
				this.enableDebugging();
				this.addCommand({
					id: "toggle-feature-flags",
					name: "Feature Flags",
					callback: () => {
						const modal = new FeatureFlagToggleModal(this.app);
						modal.open();
					},
				});
				this.addCommand({
					id: "show-debug-info",
					name: "Show Debug Information",
					callback: () => {
						const modal = new DebugModal(this.app, this);
						modal.open();
					},
				});
				this.addCommand({
					id: "reload",
					name: "Reload Relay",
					callback: async () => {
						const pluginId = this.manifest.id;
						const plugins = (this.app as any).plugins;
						await plugins.disablePlugin(pluginId);
						await plugins.enablePlugin(pluginId);
					},
				});
			} else {
				this.disableDebugging();
				this.removeCommand("toggle-feature-flags");
				this.removeCommand("show-debug-info");
				this.removeCommand("reload");
			}
		});

		this.vault = this.app.vault;
		const vaultName = this.vault.getName();
		this.fileManager = this.app.fileManager;

		this.loginManager = new LoginManager(
			this.vault.getName(),
			this.openSettings.bind(this),
			this.timeProvider,
		);
		this.relayManager = new RelayManager(this.loginManager);
		this.sharedFolders = new SharedFolders(
			this.relayManager,
			this.vault,
			this._createSharedFolder.bind(this),
			this.folderSettings,
		);

		this.tokenStore = new LiveTokenStore(
			this.loginManager,
			this.timeProvider,
			vaultName,
			3,
		);

		this.networkStatus = new NetworkStatus(this.timeProvider, HEALTH_URL);

		this.backgroundSync = new BackgroundSync(
			this.loginManager,
			this.timeProvider,
			this.sharedFolders,
		);

		if (!this.loginManager.setup()) {
			new Notice("Please sign in to use relay");
		}

		this.app.workspace.onLayoutReady(() => {
			this.sharedFolders.load();
			this._liveViews = new LiveViewManager(
				this.app,
				this.sharedFolders,
				this.loginManager,
				this.networkStatus,
			);

			// NOTE: Extensions list should be loaded once and then mutated.
			// this.app.workspace.updateOptions(); must be called to apply changes.
			this.registerEditorExtension(this._liveViews.extensions);

			this.register(
				this.loginManager.on(() => {
					if (this.loginManager.loggedIn) {
						this._onLogin();
					} else {
						this._onLogout();
					}
				}),
			);

			this.tokenStore.start();

			if (!Platform.isIosApp) {
				// We can't run network status on iOS or it will always be offline.
				this.networkStatus.addEventListener("offline", () => {
					this.tokenStore.stop();
					this.sharedFolders.forEach((folder) => folder.disconnect());
					this._liveViews.goOffline();
				});
				this.networkStatus.addEventListener("online", () => {
					this.tokenStore.start();
					this.relayManager.subscribe();
					this.relayManager.update();
					this._liveViews.goOnline();
				});
				this.networkStatus.start();
			}

			this.registerView(
				VIEW_TYPE_DIFFERENCES,
				(leaf) => new DifferencesView(leaf),
			);

			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (file instanceof TFolder) {
						const folder = this.sharedFolders.find(
							(sharedFolder) => sharedFolder.path === file.path,
						);
						if (!folder) {
							return;
						}
						menu.addItem((item) => {
							item
								.setTitle(folder.connected ? "Disconnect" : "Connect")
								.setIcon("satellite")
								.onClick(() => {
									folder.toggleConnection();
									this._liveViews.refresh("folder connection toggle");
								});
						});
						menu.addItem((item) => {
							item
								.setTitle("Folder settings")
								.setIcon("gear")
								.onClick(() => {
									this.openSettings(
										`/shared-folders?id=${folder.guid}&relay=${folder.relayId}`,
									);
								});
						});
					}
				}),
			);

			this.setup();
			this._liveViews.refresh("init");
		});
	}
	private async _createSharedFolder(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
	): Promise<SharedFolder> {
		// Initialize settings with pattern matching syntax
		const folderSettings = new NamespacedSettings<SharedFolderSettings>(
			this.settings,
			`sharedFolders/[guid=${guid}]`,
		);
		await folderSettings.flush();

		const folder = new SharedFolder(
			guid,
			path,
			this.loginManager,
			this.vault,
			this.fileManager,
			this.tokenStore,
			this.relayManager,
			this.backgroundSync,
			folderSettings,
			relayId,
			awaitingUpdates,
		);
		return folder;
	}

	private _onLogout() {
		this.tokenStore?.clear();
		this.relayManager?.logout();
		this._liveViews.refresh("logout");
	}

	private _onLogin() {
		this.sharedFolders.load();
		this.relayManager?.login();
		this._liveViews.refresh("login");
	}

	async openSettings(path: string = "/") {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const setting = (this.app as any).setting;
		await setting.open();
		await setting.openTabById("system3-relay");
		this.settingsTab.navigateTo(path);
	}

	setup() {
		this.folderNavDecorations = new FolderNavigationDecorations(
			this.vault,
			this.app.workspace,
			this.sharedFolders,
		);
		this.folderNavDecorations.refresh();

		this.settingsTab = new LiveSettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		const workspaceLog = curryLog("[Live][Workspace]", "log");

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				workspaceLog("file-open");
				plugin._liveViews.refresh("file-open");
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				workspaceLog("layout-change");
				this._liveViews.refresh("layout-change");
			}),
		);

		const vaultLog = curryLog("[System 3][Relay][Vault]", "log");

		const handleErrorEvent = (event: ErrorEvent) => {
			const error = event.error;
			if (error) {
				if (error instanceof RelayException) {
					this.toast(error);
				}
			}
			// event.preventDefault();
		};

		window.addEventListener("error", handleErrorEvent, true);
		this.register(() =>
			window.removeEventListener("error", handleErrorEvent, true),
		);

		const handlePromiseRejection = (event: PromiseRejectionEvent): void => {
			if (event.reason instanceof RelayException) {
				this.toast(event.reason);
			}
			//event.preventDefault();
		};
		const rejectionListener = (event: PromiseRejectionEvent) =>
			handlePromiseRejection(event);
		window.addEventListener("unhandledrejection", rejectionListener, true);
		this.register(() =>
			window.removeEventListener("unhandledrejection", rejectionListener, true),
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
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFolder) {
					const folder = this.sharedFolders.find(
						(folder) => folder.path === file.path,
					);
					if (folder) {
						this.sharedFolders.delete(folder);
					}
					return;
				}
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					vaultLog("Delete", file.path);
					folder.whenReady().then((folder) => {
						folder.deleteFile(file.path);
					});
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				// TODO this doesn't work for empty folders.
				if (file instanceof TFolder) {
					const sharedFolder = this.sharedFolders.find((folder) => {
						return folder.path == oldPath;
					});
					if (sharedFolder) {
						sharedFolder.move(file.path);
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
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					vaultLog("Modify", file.path);
					withFlag(flag.enableUpdateYDocFromDiskBuffer, () => {
						try {
							const doc = folder.getFile(file.path, false, false);
							if (!this._liveViews.docIsOpen(doc)) {
								folder.read(doc).then((contents) => {
									if (contents.length !== 0) {
										updateYDocFromDiskBuffer(doc.ydoc, contents);
									}
								});
							}
						} catch (e) {
							// fall back to differ
						}
					});
					this.app.metadataCache.trigger("resolve", file);
				}
			}),
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

		withFlag(flag.enableNewLinkFormat, () => {
			const patchFileToLinktext = around(MetadataCache.prototype, {
				fileToLinktext(
					old: (
						file: TFile,
						sourcePath: string,
						omitMdExtension?: boolean | undefined,
					) => string,
				) {
					return function (
						file: TFile,
						sourcePath: string,
						omitMdExtension?: boolean | undefined,
					) {
						const folder = plugin.sharedFolders.lookup(file.path);
						if (folder) {
							if (omitMdExtension === void 0) {
								omitMdExtension = true;
							}

							const fileName =
								file.extension === "md" && omitMdExtension
									? file.basename
									: file.name;
							const normalizedFileName = normalizePath(file.name);
							const destinationFiles = (
								plugin.app.metadataCache as any
							).uniqueFileLookup.get(normalizedFileName.toLowerCase());

							// If there are no conflicts (unique file), return the fileName
							if (
								destinationFiles &&
								destinationFiles.length === 1 &&
								destinationFiles[0] === file
							) {
								return fileName;
							} else {
								// If there are conflicts, use the relative path
								const filePath =
									file.extension === "md" && omitMdExtension
										? file.path.slice(0, file.path.length - 3)
										: file.path;
								const rpath = relative(sourcePath, filePath);
								if (rpath === "../" + fileName) {
									return "./" + fileName;
								}
								return rpath;
							}
						}
						// @ts-ignore
						return old.call(this, file, sourcePath, omitMdExtension);
					};
				},
			});
			this.register(patchFileToLinktext);
		});

		interface Parameters {
			action: string;
			relay?: string;
			id?: string;
		}

		this.registerObsidianProtocolHandler("relay/settings/relays", async (e) => {
			console.warn("yo!");
			const parameters = e as unknown as Parameters;
			const query = new URLSearchParams({ ...parameters }).toString();
			const path = `/${parameters.action.split("/").slice(-1)}?${query}`;
			console.log(path);
			this.openSettings(path);
		});

		this.registerObsidianProtocolHandler(
			"relay/settings/shared-folders",
			async (e) => {
				const parameters = e as unknown as Parameters;
				const query = new URLSearchParams({ ...parameters }).toString();
				const path = `/${parameters.action.split("/").slice(-1)}?${query}`;
				console.log(path);
				this.openSettings(path);
			},
		);
	}

	onunload() {
		this.timeProvider?.destroy();

		this.folderNavDecorations?.destroy();

		this.app.workspace.detachLeavesOfType(VIEW_TYPE_DIFFERENCES);

		this.backgroundSync?.destroy();
		this.backgroundSync = null as any;

		this._liveViews?.destroy();
		this._liveViews = null as any;

		this.relayManager?.destroy();
		this.relayManager = null as any;

		this.tokenStore?.stop();
		this.tokenStore?.clearState();
		this.tokenStore?.destroy();
		this.tokenStore = null as any;

		this.networkStatus?.stop();
		this.networkStatus?.destroy();
		this.networkStatus = null as any;

		this.sharedFolders.destroy();
		this.sharedFolders = null as any;

		this.settingsTab?.destroy();
		this.settingsTab = null as any;

		this.loginManager?.destroy();
		this.loginManager = null as any;

		this.app.workspace.updateOptions();
		this.app = null as any;
		this.fileManager = null as any;
		this.manifest = null as any;
		this.vault = null as any;

		this.debugSettings.destroy();
		this.debugSettings = null as any;
		this.folderSettings.destroy();
		this.folderSettings = null as any;
		this.featureSettings.destroy();
		this.featureSettings = null as any;

		FeatureFlagManager.destroy();
		PostOffice.destroy();

		this.notifier = null as any;
		this.toast = null as any;

		auditTeardown();
		flushLogs();
	}

	async loadSettings() {
		this.settings.load();
	}

	async saveSettings() {
		await this.settings.save();
	}
}
