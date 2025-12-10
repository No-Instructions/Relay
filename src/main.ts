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
import { EndpointConfigModal } from "./ui/EndpointConfigModal";
import {
	curryLog,
	setDebugging,
	RelayInstances,
	initializeLogger,
	flushLogs,
} from "./debug";
import { getPatcher, Patcher } from "./Patcher";
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

import { UpdateManager } from "./UpdateManager";
import type { PluginWithApp } from "./UpdateManager";
import { ReleaseManager } from "./ui/ReleaseManager";
import type { ReleaseSettings } from "./UpdateManager";
import { SyncSettingsManager } from "./SyncSettings";
import { ContentAddressedFileStore, isSyncFile } from "./SyncFile";
import { isDocument } from "./Document";
import { EndpointManager, type EndpointSettings } from "./EndpointManager";
import { SelfHostModal } from "./ui/SelfHostModal";

interface DebugSettings {
	debugging: boolean;
}

const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
	debugging: false,
};

interface RelaySettings extends FeatureFlags, DebugSettings {
	sharedFolders: SharedFolderSettings[];
	release: ReleaseSettings;
	endpoints: EndpointSettings;
}

const DEFAULT_SETTINGS: RelaySettings = {
	release: {
		channel: "stable",
	},
	sharedFolders: [],
	endpoints: {},
	...FeatureFlagDefaults,
	...DEFAULT_DEBUG_SETTINGS,
};

declare const HEALTH_URL: string;
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
	public endpointSettings!: NamespacedSettings<EndpointSettings>;
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
		return this.loginManager.getEndpointManager().getApiUrl() + path;
	}

	/**
	 * Open endpoint configuration modal
	 */
	openEndpointConfigurationModal() {
		const modal = new EndpointConfigModal(this.app, this, () => {
			this.reload();
		});
		modal.open();
	}

	/**
	 * Validate and apply custom endpoints
	 */
	async validateAndApplyEndpoints() {
		const settings = this.endpointSettings.get();

		if (!settings.activeTenantId || !settings.tenants?.length) {
			new Notice("Please configure an enterprise tenant first", 4000);
			return;
		}

		const notice = new Notice("Validating endpoints...", 0);

		try {
			const result = await this.loginManager.validateAndApplyEndpoints();
			notice.hide();

			if (result.success) {
				// Clear any previous validation errors on success
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: undefined,
					_lastValidationAttempt: undefined,
				}));
				new Notice("✓ Endpoints validated and applied successfully!", 5000);
				if (result.licenseInfo) {
					this.log("License validation successful:", result.licenseInfo);
				}
			} else {
				// Store validation error for display in settings
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: result.error,
					_lastValidationAttempt: Date.now(),
				}));
				new Notice(`❌ Validation failed: ${result.error}`, 8000);
			}
		} catch (error) {
			notice.hide();
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			// Store validation error for display in settings
			await this.endpointSettings.update((current) => ({
				...current,
				_lastValidationError: errorMessage,
				_lastValidationAttempt: Date.now(),
			}));
			new Notice(`❌ Validation error: ${errorMessage}`, 8000);
		}
	}

	/**
	 * Reset to default endpoints
	 */
	resetToDefaultEndpoints() {
		this.loginManager.getEndpointManager().clearValidatedEndpoints();
		this.endpointSettings.update(() => ({}));
		new Notice("Reset to default endpoints", 3000);
	}

	/**
	 * Validate custom endpoints on startup if configured
	 */
	private async validateEndpointsOnStartup(
		endpointManager: EndpointManager,
	): Promise<void> {
		const settings = this.endpointSettings.get();

		// Skip if no active tenant configured
		if (!settings.activeTenantId || !settings.tenants?.length) {
			this.log("No active enterprise tenant configured, using defaults");
			return;
		}

		const activeTenant = settings.tenants.find(
			(t) => t.id === settings.activeTenantId,
		);
		if (!activeTenant) {
			this.log("Active tenant not found, using defaults");
			return;
		}

		this.log("Enterprise tenant configured, validating on startup...", {
			tenantId: activeTenant.id,
			tenantUrl: activeTenant.tenantUrl,
			tenantName: activeTenant.name,
		});

		try {
			// Use shorter timeout for startup validation to avoid blocking startup
			const result = await endpointManager.validateAndSetEndpoints(5000);

			if (result.success) {
				// Clear any previous validation errors on successful startup validation
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: undefined,
					_lastValidationAttempt: undefined,
				}));
				this.log("✓ Enterprise tenant validated and applied on startup", {
					licenseInfo: result.licenseInfo,
				});
			} else {
				this.error(
					"❌ Enterprise tenant validation failed on startup",
					result.error,
				);
				// Store the error for display in settings
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: result.error,
					_lastValidationAttempt: Date.now(),
				}));
				new Notice(
					`❌ Custom endpoints failed validation: ${result.error}`,
					8000,
				);
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			this.error("Startup endpoint validation error:", errorMessage);
			// Store the error for display in settings
			await this.endpointSettings.update((current) => ({
				...current,
				_lastValidationError: errorMessage,
				_lastValidationAttempt: Date.now(),
			}));
			new Notice(`❌ Endpoint validation error: ${errorMessage}`, 8000);
		}
	}
	async onload() {
		this.appId = (this.app as any).appId;
		const start = moment.now();
		RelayInstances.set(this, "plugin");
		this.timeProvider = new DefaultTimeProvider();
		this.register(() => {
			this.timeProvider.destroy();
		});

		const logFilePath = normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/relay.log`,
		);

		initializeLogger(
			new ObsidianFileAdapter(this.app.vault),
			this.timeProvider,
			logFilePath,
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
		this.endpointSettings = new NamespacedSettings(this.settings, "endpoints");

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

		this.register(
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
				} else {
					this.removeCommand("toggle-feature-flags");
					this.removeCommand("send-bug-report");
					this.removeCommand("show-debug-info");
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
			}),
		);

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

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				this.openSettings();
			},
		});

		this.addCommand({
			id: "configure-endpoints",
			name: "Configure enterprise tenant",
			callback: () => {
				this.openEndpointConfigurationModal();
			},
		});

		if (flags().enableSelfManageHosts) {
			this.addCommand({
				id: "register-host",
				name: "Register self-hosted Relay Server",
				callback: () => {
					const modal = new SelfHostModal(
						this.app,
						this.relayManager,
						(relay) => {
							// Open relay settings after successful creation
							this.openSettings(`/relays?id=${relay.id}`);
						},
					);
					this.openModals.push(modal);
					modal.open();
				},
			});
		}

		// Register handler for update availability changes
		this.register(this.updateManager.subscribe(() => {
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
		}));

		this.vault = this.app.vault;
		const vaultName = this.vault.getName();
		this.fileManager = this.app.fileManager;

		this.hashStore = new ContentAddressedFileStore(this.appId);

		// Initialize and validate endpoints before creating LoginManager
		const endpointManager = new EndpointManager(this.endpointSettings);
		await this.validateEndpointsOnStartup(endpointManager);

		this.loginManager = new LoginManager(
			this.vault.getName(),
			this.openSettings.bind(this),
			this.timeProvider,
			this.patchWebviewer.bind(this),
			this.loginSettings,
			endpointManager,
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
									.setTitle("Relay: Relay settings")
									.setIcon("gear")
									.onClick(() => {
										this.openSettings(`/relays?id=${folder.relayId}`);
									});
							});
							menu.addItem((item) => {
								item
									.setTitle("Relay: Local folder settings")
									.setIcon("gear")
									.onClick(() => {
										this.openSettings(`/shared-folders?id=${folder.guid}`);
									});
							});
							menu.addItem((item) => {
								item
									.setTitle(
										folder.connected ? "Relay: Disconnect" : "Relay: Connect",
									)
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
						} else {
							menu.addItem((item) => {
								item
									.setTitle("Relay: Local folder settings")
									.setIcon("gear")
									.onClick(() => {
										this.openSettings(`/shared-folders?id=${folder.guid}`);
									});
							});
						}
						if (folder.relayId && folder.connected) {
							menu.addItem((item) => {
								item
									.setTitle("Relay: Sync")
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
									.setTitle("Relay: Download")
									.setIcon("cloud-download")
									.onClick(async () => {
										await ifile.pull();
										new Notice(`Download complete: ${ifile.name}`);
									});
							});
							if (this.debugSettings.get().debugging) {
								menu.addItem((item) => {
									item
										.setTitle("Relay: Verify upload")
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
									.setTitle("Relay: Upload")
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

			const apiUrl = this.loginManager.getEndpointManager().getApiUrl();
			const apiRegExp = new RegExp(apiUrl.replace("/", "\\/") + ".*");
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
					vaultLog("Rename", file.path, oldPath);
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
					const file = folder.proxy.getFile(tfile);
					if (file && isSyncFile(file)) {
						file.sync();
					}
					// Dataview race condition
					this.timeProvider.setTimeout(() => {
						this.app.metadataCache.trigger("resolve", file);
					}, 10);
				}
			}),
		);

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;

		getPatcher().patch(MarkdownView.prototype, {
			// When this is called, the active editors haven't yet updated.
			onUnloadFile(old: any) {
				return function (file: any) {
					plugin._liveViews.wipe();
					// @ts-ignore
					return old.call(this, file);
				};
			},
		});

		getPatcher().patch(this.app.vault, {
			process(old: any) {
				return function (
					tfile: any,
					fn: (data: string) => string,
					options: any,
				) {
					try {
						const folder = plugin.sharedFolders.lookup(tfile.path);
						if (folder) {
							const file = folder.proxy.getFile(tfile);
							if (tfile instanceof TFile && file && isDocument(file)) {
								file.process(fn);
							}
						}
					} catch (e: any) {
						plugin.log(e);
					}

					// @ts-ignore
					return old.call(this, tfile, fn, options);
				};
			},
		});

		this.patchWebviewer();

		withFlag(flag.enableNewLinkFormat, () => {
			getPatcher().patch(MetadataCache.prototype, {
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
		// Cleanup all monkeypatches and destroy the singleton
		Patcher.destroy();

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

		// Destroy FeatureFlagManager before destroying featureSettings
		FeatureFlagManager.destroy();

		this.featureSettings.destroy();
		this.featureSettings = null as any;
		this.releaseSettings.destroy();
		this.releaseSettings = null as any;
		this.loginSettings.destroy();
		this.loginSettings = null as any;
		this.endpointSettings.destroy();
		this.endpointSettings = null as any;

		this.interceptedUrls.length = 0;
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
