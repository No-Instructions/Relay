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
	requireApiVersion,
	Modal,
	moment,
} from "obsidian";
import { Platform } from "obsidian";
import { relative } from "path-browserify";
import { SharedFolder } from "./SharedFolder";
import type { SharedFolderSettings } from "./SharedFolder";
import { LiveViewManager } from "./LiveViews";

import { SharedFolders } from "./SharedFolder";
import { FolderNavigationDecorations } from "./ui/FolderNav";
import { LiveSettingsTab } from "./ui/SettingsTab";
import { LoginManager, type LoginSettings } from "./LoginManager";
import {
	curryLog,
	setDebugging,
	RelayInstances,
	initializeLogger,
	flushLogs,
} from "./debug";
import { around } from "monkey-around";
import { LiveTokenStore } from "./LiveTokenStore";
import NetworkStatus from "./NetworkStatus";
import { RelayManager } from "./RelayManager";
import { DefaultTimeProvider, type TimeProvider } from "./TimeProvider";
import { auditTeardown } from "./observable/Observable";
import { Plugin } from "obsidian";

import {
	DifferencesView,
	VIEW_TYPE_DIFFERENCES,
} from "./differ/differencesView";
import { FeatureFlagDefaults, flag, type FeatureFlags } from "./flags";
import { FeatureFlagManager, flags, withFlag } from "./flagManager";
import { PostOffice } from "./observable/Postie";
import { BackgroundSync } from "./BackgroundSync";
import { FeatureFlagToggleModal } from "./ui/FeatureFlagModal";
import { DebugModal } from "./ui/DebugModal";
import { NamespacedSettings, Settings } from "./SettingsStorage";
import { ObsidianFileAdapter, ObsidianNotifier } from "./debugObsididan";
import { BugReportModal } from "./ui/BugReportModal";
import { IndexedDBAnalysisModal } from "./ui/IndexedDBAnalysisModal";

import { SyncQueueModal } from "./ui/SyncQueueModal";
import { UpdateManager } from "./UpdateManager";
import type { PluginWithApp } from "./UpdateManager";
import { ReleaseManager } from "./ui/ReleaseManager";
import type { ReleaseSettings } from "./UpdateManager";
import { SyncSettingsManager } from "./SyncSettings";
import { ContentAddressedFileStore, isSyncFile } from "./SyncFile";
import { isDocument } from "./Document";

interface DebugSettings {
	debugging: boolean;
}

const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
	debugging: false,
};

interface RelaySettings extends FeatureFlags, DebugSettings {
	sharedFolders: SharedFolderSettings[];
	release: ReleaseSettings;
}

const DEFAULT_SETTINGS: RelaySettings = {
	release: {
		channel: "stable",
	},
	sharedFolders: [],
	...FeatureFlagDefaults,
	...DEFAULT_DEBUG_SETTINGS,
};

declare const HEALTH_URL: string;
declare const API_URL: string;
declare const GIT_TAG: string;
declare const REPOSITORY: string;

export default class Live extends Plugin {
	appId!: string;
	webviewerPatched = false;
	openModals: Modal[] = [];
	loadTime?: number;
	sharedFolders!: SharedFolders;
	vault!: Vault;
	notifier!: ObsidianNotifier;
	loginManager!: LoginManager;
	timeProvider!: TimeProvider;
	fileManager!: FileManager;
	tokenStore!: LiveTokenStore;
	interceptedUrls: Array<string | RegExp> = [];
	networkStatus!: NetworkStatus;
	backgroundSync!: BackgroundSync;
	folderNavDecorations!: FolderNavigationDecorations;
	relayManager!: RelayManager;
	settingsTab!: LiveSettingsTab;
	settings!: Settings<RelaySettings>;
	updateManager!: UpdateManager;
	private featureSettings!: NamespacedSettings<FeatureFlags>;
	private debugSettings!: NamespacedSettings<DebugSettings>;
	private folderSettings!: NamespacedSettings<SharedFolderSettings[]>;
	public releaseSettings!: NamespacedSettings<ReleaseSettings>;
	public loginSettings!: NamespacedSettings<LoginSettings>;
	debug!: (...args: unknown[]) => void;
	log!: (...args: unknown[]) => void;
	warn!: (...args: unknown[]) => void;
	error!: (...args: unknown[]) => void;
	private _liveViews!: LiveViewManager;
	fileDiffMergeWarningKey = "file-diff-merge-warning";
	version = GIT_TAG;
	repo = REPOSITORY;
	hashStore!: ContentAddressedFileStore;

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
		this.appId = (this.app as any).appId;
		const start = moment.now();
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

		this.debug = curryLog("[System 3][Relay]", "debug");
		this.log = curryLog("[System 3][Relay]", "log");
		this.warn = curryLog("[System 3][Relay]", "warn");
		this.error = curryLog("[System 3][Relay]", "error");

		this.settings = new Settings(this, DEFAULT_SETTINGS);
		await this.settings.load();

		this.featureSettings = new NamespacedSettings(this.settings, "(enable*)");
		this.debugSettings = new NamespacedSettings(this.settings, "(debugging)");
		this.folderSettings = new NamespacedSettings(
			this.settings,
			"sharedFolders",
		);
		this.releaseSettings = new NamespacedSettings(this.settings, "release");
		this.loginSettings = new NamespacedSettings(this.settings, "login");

		const flagManager = FeatureFlagManager.getInstance();
		flagManager.setSettings(this.featureSettings);

		this.settingsTab = new LiveSettingsTab(this.app, this);
		this.addRibbonIcon("satellite", "Relay", () => {
			this.openSettings();
		});

		// Initialize update manager
		this.updateManager = new UpdateManager(
			this as unknown as PluginWithApp,
			this.timeProvider,
			this.releaseSettings,
		);

		this.debugSettings.subscribe((settings) => {
			if (settings.debugging) {
				this.enableDebugging();
				this.removeCommand("enable-debugging");
				this.addCommand({
					id: "toggle-feature-flags",
					name: "Show feature flags",
					callback: () => {
						const modal = new FeatureFlagToggleModal(this.app, () => {
							this.reload();
						});
						this.openModals.push(modal);
						modal.open();
					},
				});
				this.addCommand({
					id: "send-bug-report",
					name: "Send bug report",
					callback: () => {
						const modal = new BugReportModal(this.app, this);
						this.openModals.push(modal);
						modal.open();
					},
				});
				this.addCommand({
					id: "show-debug-info",
					name: "Show debug info",
					callback: () => {
						const modal = new DebugModal(this.app, this);
						this.openModals.push(modal);
						modal.open();
					},
				});
				this.addCommand({
					id: "show-release-manager",
					name: "Show releases",
					callback: () => {
						const modal = new ReleaseManager(this.app, this);
						this.openModals.push(modal);
						modal.open();
					},
				});
				this.addCommand({
					id: "analyze-indexeddb",
					name: "Analyze database",
					callback: () => {
						const modal = new IndexedDBAnalysisModal(this.app, this);
						this.openModals.push(modal);
						modal.open();
					},
				});
				this.addCommand({
					id: "disable-debugging",
					name: "Disable debugging",
					callback: () => {
						this.disableDebugging(true);
					},
				});
				this.addCommand({
					id: "show-sync-status",
					name: "Sync status",
					callback: () => {
						const modal = new SyncQueueModal(
							this.app,
							this.backgroundSync,
							this.sharedFolders,
						);
						this.openModals.push(modal);
						modal.open();
					},
				});
			} else {
				this.removeCommand("toggle-feature-flags");
				this.removeCommand("send-bug-report");
				this.removeCommand("show-debug-info");
				this.removeCommand("show-sync-status");
				this.removeCommand("show-release-manager");
				this.removeCommand("disable-debugging");
				this.addCommand({
					id: "enable-debugging",
					name: "Enable debugging",
					callback: () => {
						this.enableDebugging(true);
					},
				});
			}
		});

		const code = `async function() {
			const app = window.app;
			await app.plugins.disablePlugin("system3-relay");
			await app.plugins.enablePlugin("system3-relay");
		}`;
		(this.app as any).reloadRelay = new Function("return " + code);

		this.addCommand({
			id: "reload",
			name: "Reload Relay",
			callback: (this.app as any).reloadRelay(),
		});

		// Register handler for update availability changes
		this.updateManager.subscribe(() => {
			const newRelease = this.updateManager.getNewRelease();
			if (newRelease) {
				// Add update command when an update is available
				this.removeCommand("update-plugin");
				this.addCommand({
					id: "update-plugin",
					name: `Update Plugin (${this.version} → ${newRelease.tag_name})`,
					callback: async () => {
						await this.updateManager.installUpdate(newRelease);
					},
				});
				this.log(`Update available: v${this.version} → ${newRelease.tag_name}`);
			} else {
				// Remove update command when no update is available
				this.removeCommand("update-plugin");
			}
		});

		this.vault = this.app.vault;
		const vaultName = this.vault.getName();
		this.fileManager = this.app.fileManager;

		this.hashStore = new ContentAddressedFileStore(this.appId);

		this.loginManager = new LoginManager(
			this.vault.getName(),
			this.openSettings.bind(this),
			this.timeProvider,
			this.patchWebviewer.bind(this),
			this.loginSettings,
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
						if (folder.relayId) {
							menu.addItem((item) => {
								item
									.setTitle("Relay settings")
									.setIcon("gear")
									.onClick(() => {
										this.openSettings(`/relays?id=${folder.relayId}`);
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
							menu.addItem((item) => {
								item
									.setTitle(folder.connected ? "Disconnect" : "Connect")
									.setIcon("satellite")
									.onClick(() => {
										if (folder.connected) {
											folder.shouldConnect = false;
											folder.disconnect();
										} else {
											folder.shouldConnect = true;
											folder.connect();
										}
										this._liveViews.refresh("folder connection toggle");
									});
							});
						}
						if (folder.relayId && flags().enableSyncModal) {
							menu.addItem((item) => {
								item
									.setTitle("Sync Status")
									.setIcon("list-checks")
									.onClick(() => {
										const modal = new SyncQueueModal(
											this.app,
											this.backgroundSync,
											this.sharedFolders,
											folder.guid,
										);
										this.openModals.push(modal);
										modal.open();
									});
							});
						}
						if (flags().enableSyncMenu && folder.relayId && folder.connected) {
							menu.addItem((item) => {
								item
									.setTitle("Sync")
									.setIcon("folder-sync")
									.onClick(() => {
										folder.netSync();
									});
							});
						}
					} else if (file instanceof TFile) {
						const folder = this.sharedFolders.lookup(file.path);
						const ifile = folder?.getFile(file);
						if (ifile && isSyncFile(ifile)) {
							menu.addItem((item) => {
								item
									.setTitle("Download")
									.setIcon("cloud-download")
									.onClick(async () => {
										await ifile.pull();
										new Notice(`Download complete: ${ifile.name}`);
									});
							});
							if (this.debugSettings.get().debugging) {
								menu.addItem((item) => {
									item
										.setTitle("Verify upload")
										.setIcon("search-check")
										.onClick(async () => {
											const present = await ifile.verifyUpload();
											new Notice(
												`${ifile.name} ${present ? "on server" : "missing from server"}`,
											);
										});
								});
							}
							menu.addItem((item) => {
								item
									.setTitle("Upload")
									.setIcon("cloud-upload")
									.onClick(async () => {
										await ifile.push(true);
										const present = await ifile.verifyUpload();
										new Notice(
											`${present ? "File uploaded:" : "File upload failed:"} ${ifile.name}`,
										);
									});
							});
						}
					}
				}),
			);
			this.setup();
			this._liveViews.refresh("init");
			this.loadTime = moment.now() - start;
		});
	}

	async reload() {
		(this.app as any).reloadRelay()();
	}

	private _createSharedFolder(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
	): SharedFolder {
		// Initialize settings with pattern matching syntax
		const folderSettings = new NamespacedSettings<SharedFolderSettings>(
			this.settings,
			`sharedFolders/[guid=${guid}]`,
		);
		const settings: SharedFolderSettings = { guid: guid, path: path };
		if (relayId) {
			settings["relay"] = relayId;
		}
		folderSettings.update((current) => {
			return {
				...current,
				path,
				guid,
				...(relayId ? { relay: relayId } : {}),
				...{
					sync: current.sync ? current.sync : SyncSettingsManager.defaultFlags,
				},
			};
		}, true);

		const folder = new SharedFolder(
			this.appId,
			guid,
			path,
			this.loginManager,
			this.vault,
			this.fileManager,
			this.tokenStore,
			this.relayManager,
			this.hashStore,
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

	patchWebviewer(): void {
		// eslint-disable-next-line
		const plugin = this;
		try {
			if (this.webviewerPatched) {
				return;
			}

			const webviewer = (this.app as any).internalPlugins?.plugins?.webviewer;
			if (!webviewer?.instance?.options || !webviewer.enabled) {
				this.warn("Webviewer plugin not found or not initialized");
				return;
			}

			const options = webviewer.instance.options;
			const originalDesc = Object.getOwnPropertyDescriptor(
				options,
				"openExternalURLs",
			);

			if (!originalDesc) {
				this.warn("Could not find openExternalURLs property");
				return;
			}

			Object.defineProperty(options, "openExternalURLs", {
				get() {
					const currentEvent = window.event as any;
					if (currentEvent?.type === "open-url" && currentEvent?.detail?.url) {
						const url = currentEvent.detail.url;
						for (const pattern of plugin.interceptedUrls) {
							if (
								(typeof pattern === "string" && url.startsWith(pattern)) ||
								(pattern instanceof RegExp && pattern.test(url))
							) {
								plugin.log(
									"Intercepted webviewer, opening in default browser",
									currentEvent.detail.url,
								);
								return false;
							}
						}
					}
					return originalDesc.value;
				},
				set(value) {
					originalDesc.value = value;
				},
				configurable: true,
			});

			this.register(() => {
				Object.defineProperty(options, "openExternalURLs", originalDesc);
			});

			const intercepts = this.loginManager.getWebviewIntercepts();
			intercepts.forEach((intercept) => {
				this.debug("Intercepting Webviewer for URL pattern", intercept.source);
				this.interceptedUrls.push(intercept);
			});

			const apiRegExp = new RegExp(API_URL.replace("/", "\\/") + ".*");
			this.debug("Intercepting Webviewer for URL pattern", apiRegExp.source);
			this.interceptedUrls.push(apiRegExp);

			this.webviewerPatched = true;
			this.debug("patched webviewer options");
		} catch (error) {
			this.error("Failed to patch webviewer:", error);
		}
	}

	setup() {
		this.folderNavDecorations = new FolderNavigationDecorations(
			this.vault,
			this.app.workspace,
			this.sharedFolders,
			this.backgroundSync,
		);
		this.folderNavDecorations.refresh();

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

		const handlePromiseRejection = (event: PromiseRejectionEvent): void => {
			//event.preventDefault();
		};
		const rejectionListener = (event: PromiseRejectionEvent) =>
			handlePromiseRejection(event);
		window.addEventListener("unhandledrejection", rejectionListener, true);
		this.register(() =>
			window.removeEventListener("unhandledrejection", rejectionListener, true),
		);

		this.registerEvent(
			this.app.vault.on("create", (tfile) => {
				// NOTE: this is called on every file at startup...
				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					const newDocs = folder.placeHold([tfile]);
					if (newDocs.length > 0) {
						folder.uploadFile(tfile);
					} else {
						folder.whenReady().then((folder) => {
							folder.getFile(tfile);
						});
					}
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
						return;
					}
				}
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					vaultLog("Delete", file.path);
					folder.whenReady().then((folder) => {
						folder.proxy.deleteFile(file.path);
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
						return;
					}
				}
				const fromFolder = this.sharedFolders.lookup(oldPath);
				const toFolder = this.sharedFolders.lookup(file.path);
				const folder = fromFolder || toFolder;
				if (fromFolder && toFolder) {
					// between two shared folders
					vaultLog("Rename", file.path, oldPath);
					fromFolder.renameFile(file, oldPath);
					toFolder.renameFile(file, oldPath);
					this._liveViews.refresh("rename");
					this.folderNavDecorations.quickRefresh();
				} else if (folder) {
					vaultLog("Rename", file, oldPath);
					folder.renameFile(file, oldPath);
					this._liveViews.refresh("rename");
					this.folderNavDecorations.refresh();
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (tfile) => {
				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					vaultLog("Modify", tfile.path);
					if (flags().enableDesyncPill) {
						this.folderNavDecorations.quickRefresh();
					}
					const file = folder.proxy.getFile(tfile);
					if (file && isSyncFile(file)) {
						file.sync();
					}
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

		const patchProcess = around(this.app.vault, {
			process(old) {
				return function (tfile, fn: (data: string) => string, options: any) {
					try {
						const folder = plugin.sharedFolders.lookup(tfile.path);
						if (folder) {
							const file = folder.proxy.getFile(tfile);
							if (tfile instanceof TFile && file && isDocument(file)) {
								file.process(fn);
							}
						}
					} catch (e: any) {
						console.warn(e);
					}

					// @ts-ignore
					return old.call(this, tfile, fn, options);
				};
			},
		});
		this.register(patchProcess);

		this.patchWebviewer();

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
			version?: string;
		}

		this.registerObsidianProtocolHandler("relay/settings/relays", async (e) => {
			const parameters = e as unknown as Parameters;
			const query = new URLSearchParams({ ...parameters }).toString();
			const path = `/${parameters.action.split("/").slice(-1)}?${query}`;
			this.openSettings(path);
		});

		this.registerObsidianProtocolHandler(
			"relay/settings/shared-folders",
			async (e) => {
				const parameters = e as unknown as Parameters;
				const query = new URLSearchParams({ ...parameters }).toString();
				const path = `/${parameters.action.split("/").slice(-1)}?${query}`;
				this.openSettings(path);
			},
		);

		this.registerObsidianProtocolHandler("relay/upgrade", async (e) => {
			const parameters = e as unknown as Parameters;
			const version = parameters.version?.trim();
			this.installVersion(version);
		});

		this.backgroundSync.start();
		this.updateManager.start();
	}

	installVersion(version?: string) {
		const modal = new ReleaseManager(this.app, this, version);

		const app = this.app as any;
		const setting = app.setting;
		setting.close();

		this.openModals.push(modal);
		modal.open();
	}

	removeCommand(command: string): void {
		// [Polyfill] removeCommand was added in 1.7.2
		if (requireApiVersion("1.7.2")) {
			// @ts-ignore
			super.removeCommand(command);
		} else {
			const appAny = this.app as any;
			const appCommands = appAny.commands;
			const qualifiedCommand = `system3-relay:${command}`;
			if (
				appCommands.commands.hasOwnProperty(qualifiedCommand) ||
				appAny.hotkeyManager.removeDefaultHotkeys(qualifiedCommand)
			) {
				delete appCommands.commands[qualifiedCommand];
				delete appCommands.editorCommands[qualifiedCommand];
			}
		}
	}

	onunload() {
		this.timeProvider?.destroy();

		this.folderNavDecorations?.destroy();

		this.app.workspace.detachLeavesOfType(VIEW_TYPE_DIFFERENCES);

		// Explicitly destroy the update manager
		if (this.updateManager) {
			this.updateManager.destroy();
			this.updateManager = null as any;
		}

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

		this.openModals.forEach((modal) => {
			modal.close();
		});
		this.openModals.length = 0;

		this.sharedFolders?.destroy();
		this.sharedFolders = null as any;

		this.settingsTab?.destroy();
		this.settingsTab = null as any;

		this.loginManager?.destroy();
		this.loginManager = null as any;

		this.backgroundSync?.destroy();
		this.backgroundSync = null as any;

		this.hashStore.destroy();
		this.hashStore = null as any;

		this.app?.workspace.updateOptions();
		(this.app as any).reloadRelay = undefined;
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
		this.releaseSettings.destroy();
		this.releaseSettings = null as any;

		this.interceptedUrls.length = 0;

		FeatureFlagManager.destroy();
		PostOffice.destroy();

		this.notifier = null as any;

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
