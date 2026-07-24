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
	type TAbstractFile,
} from "obsidian";
import { Platform } from "obsidian";
import { relative } from "path-browserify";
import { SharedFolder } from "./SharedFolder";
import type { SharedFolderSettings } from "./SharedFolder";
import type { MetadataBridge } from "./editorContext";
import { S3RN } from "./S3RN";
import { LiveViewManager } from "./LiveViews";
import {
	isUserAttributionOn,
	toggleUserAttribution,
} from "./y-codemirror.next/UserAttributionPlugin";

import { SharedFolders } from "./SharedFolder";
import { FolderNavigationDecorations } from "./ui/FolderNav";
import { GatedDeletionController } from "./ui/GatedDeletionController";
import { GatedDeletionModal } from "./ui/GatedDeletionModal";
import { sharedFolderGateView } from "./ui/GatedDeletionView";
import { MetadataHealthSidebarNoticeMount } from "./ui/MetadataHealthSidebarNotice";
import { ResourceMeterMount } from "./ui/ResourceMeter";
import { LiveSettingsTab } from "./ui/SettingsTab";
import { LoginManager, type LoginSettings } from "./LoginManager";
import { EndpointConfigModal } from "./ui/EndpointConfigModal";
import {
	curryLog,
	setDebugging,
	RelayInstances,
	initializeLogger,
	flushLogs,
	initializeMetrics,
	initializeHSMRecording,
	stopHSMRecording,
} from "./debug";
import { getPatcher, Patcher } from "./Patcher";
import { SavingFlagPolyfill } from "./SavingFlagPolyfill";
import { LiveTokenStore } from "./LiveTokenStore";
import NetworkStatus from "./NetworkStatus";
import { RelayManager } from "./RelayManager";
import { DefaultTimeProvider, type TimeProvider } from "./TimeProvider";
import { auditTeardown } from "./observable/Observable";
import { PromiseTracker, setActiveTracker, trackPromise } from "./trackPromise";
import { Plugin } from "obsidian";

import {
	DifferencesView,
	VIEW_TYPE_DIFFERENCES,
} from "./differ/differencesView";
import { FeatureFlagDefaults, flag, type FeatureFlags } from "./flags";
import { FeatureFlagManager, flags, withFlag } from "./flagManager";
import { PostOffice } from "./observable/Postie";
import { BackgroundSync } from "./BackgroundSync";
import { HSMStore } from "./merge-hsm/persistence";
import { trackAsyncCleanup } from "./reloadUtils";
import { isDestroyedError } from "./DestroyedError";
import { FeatureFlagToggleModal } from "./ui/FeatureFlagModal";
import { DebugModal } from "./ui/DebugModal";
import {
	SyncStatusView,
	VIEW_TYPE_SYNC_STATUS,
	detachSyncStatusViews,
	openSyncStatusView,
} from "./ui/SyncStatusView";
import { NamespacedSettings, Settings } from "./SettingsStorage";
import { ObsidianFileAdapter, ObsidianNotifier } from "./debugObsididan";
import { BugReportModal } from "./ui/BugReportModal";
import { IndexedDBAnalysisModal } from "./ui/IndexedDBAnalysisModal";

import { UpdateManager } from "./UpdateManager";
import type { PluginWithVersion, Release } from "./UpdateManager";
import { ReleaseManager } from "./ui/ReleaseManager";
import type { ReleaseSettings } from "./UpdateManager";
import { SyncSettingsManager } from "./SyncSettings";
import { ContentAddressedFileStore, isSyncFile } from "./SyncFile";
import { isDocument } from "./Document";
import { EndpointManager, type EndpointSettings } from "./EndpointManager";
import { generateHash } from "./hashing";
import { normalizeNoteText } from "./diskText";
import { SelfHostModal } from "./ui/SelfHostModal";
import { DeviceManager } from "./DeviceManager";
import type { RemoteSharedFolder } from "./Relay";
import {
	setDeviceManagementConfig,
	setPluginRequestConfig,
} from "./customFetch";
import { RelayDebugAPI } from "./RelayDebugAPI";
import { isRetryableS3Error } from "./S3Error";
import { MetadataHealth } from "./MetadataHealth";
import { routeVaultDelete, routeVaultRename } from "./vaultEventRouting";

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

type VaultDeleteEvent = {
	path: string;
	isFolder: boolean;
};

declare const HEALTH_URL: string;
declare const GIT_TAG: string;
declare const REPOSITORY: string;

export default class Live extends Plugin {
	appId!: string;
	private _instanceId!: string;
	webviewerPatched = false;
	openModals: Modal[] = [];
	loadTime?: number;
	private _unloading = false;
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
	private gatedDeletions: GatedDeletionController | null = null;
	private metadataHealthSidebarNotice: MetadataHealthSidebarNoticeMount | null = null;
	private resourceMeter: ResourceMeterMount | null = null;
	relayManager!: RelayManager;
	deviceManager!: DeviceManager;
	private relayDebugAPI!: RelayDebugAPI;
	private metadataHealth: MetadataHealth | null = null;
	private savingFlagPolyfill: SavingFlagPolyfill | null = null;
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
	private pendingVaultDeletes: VaultDeleteEvent[] = [];
	private pendingVaultDeleteFlush: number | null = null;
	get metadataBridge(): MetadataBridge | undefined {
		return this._liveViews;
	}
	fileDiffMergeWarningKey = "file-diff-merge-warning";
	version = GIT_TAG;
	repo = REPOSITORY;
	hashStore!: ContentAddressedFileStore;
	private _hsmStore!: HSMStore;
	promises = new PromiseTracker();

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

	private queueVaultDelete(
		file: TAbstractFile,
		vaultLog: (...args: unknown[]) => void,
	) {
		this.pendingVaultDeletes.push({
			path: file.path,
			isFolder: file instanceof TFolder,
		});
		if (this.pendingVaultDeleteFlush !== null) {
			return;
		}
		this.pendingVaultDeleteFlush = window.setTimeout(() => {
			this.pendingVaultDeleteFlush = null;
			this.flushVaultDeletes(vaultLog);
		}, 0);
	}

	private flushVaultDeletes(vaultLog: (...args: unknown[]) => void) {
		const events = this.pendingVaultDeletes;
		this.pendingVaultDeletes = [];
		if (events.length === 0 || this._unloading) {
			return;
		}

		const removedSharedRoots: { folder: SharedFolder; path: string }[] = [];
		for (const event of events) {
			if (!event.isFolder) {
				continue;
			}
			const folder = this.sharedFolders.find(
				(folder) => folder.path === event.path,
			);
			if (
				folder &&
				!removedSharedRoots.some((entry) => entry.folder === folder)
			) {
				removedSharedRoots.push({ folder, path: folder.path });
			}
		}
		// Legacy folders: the root filter destroys the registration
		// immediately and swallows same-batch children. FolderHSM folders:
		// the root deletion is a collector signal — the burst (children
		// included, which flow through notifyVaultDelete below) classifies
		// as detach after the quiet window, nothing replicates, and the
		// registration suspends relinkably instead of being destroyed.
		const destroyedRoots: { folder: SharedFolder; path: string }[] = [];
		for (const entry of removedSharedRoots) {
			if (entry.folder.folderHSM) {
				entry.folder.onRootDetach = () => {
					this.sharedFolders.suspend(entry.folder);
				};
				entry.folder.notifyVaultRootDeleted();
			} else {
				destroyedRoots.push(entry);
			}
		}
		for (const { folder } of destroyedRoots) {
			this.sharedFolders.delete(folder);
		}

		const isUnderRemovedSharedRoot = (path: string): boolean => {
			return destroyedRoots.some(
				(root) => path === root.path || path.startsWith(root.path + "/"),
			);
		};
		const batches = new Map<
			SharedFolder,
			{ files: Set<string>; folders: Set<string> }
		>();
		for (const event of events) {
			if (isUnderRemovedSharedRoot(event.path)) {
				continue;
			}
			const folder = this.sharedFolders.lookup(event.path);
			if (!folder) {
				continue;
			}
			const vpath = folder.getVirtualPath(event.path);
			// Consume the suppression token: this vault event IS the echo of
			// our own trash effect.
			if (folder.consumePendingDelete(vpath)) {
				continue;
			}
			vaultLog("Delete", event.path);
			if (routeVaultDelete(folder, vpath)) {
				// Local delete intent flows through the machine; its
				// MAP_DELETE effect executes the map mutation.
				continue;
			}
			let batch = batches.get(folder);
			if (!batch) {
				batch = { files: new Set<string>(), folders: new Set<string>() };
				batches.set(folder, batch);
			}
			if (event.isFolder) {
				batch.folders.add(vpath);
			} else {
				batch.files.add(vpath);
			}
		}

		for (const [folder, batch] of batches) {
			const deletePaths = folder
				.expandDeletePaths(batch.files, batch.folders)
				.filter((vpath) => !folder.isPendingDelete(vpath));
			if (deletePaths.length === 0) {
				continue;
			}
			deletePaths.forEach((vpath) => folder.markPendingDelete(vpath));
			folder
				.whenReady()
				.then((readyFolder) => {
					if (readyFolder.destroyed) {
						return;
					}
					readyFolder.deleteFiles(deletePaths);
				})
				.catch((error) => {
					if (isDestroyedError(error)) {
						return;
					}
					this.error("vault delete failed", error);
				})
				.finally(() => {
					deletePaths.forEach((vpath) => folder.clearPendingDelete(vpath));
				});
		}
	}

	buildApiUrl(path: string) {
		return this.loginManager.getEndpointManager().getApiUrl() + path;
	}

	/**
	 * Open endpoint configuration modal
	 */
	openEndpointConfigurationModal() {
		const modal = new EndpointConfigModal(this.app, this);
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
				new Notice("✓ endpoints validated and applied successfully!", 5000);
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

	private getPluginMainJsPath(): string {
		const pluginDir =
			this.manifest.dir ??
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return normalizePath(`${pluginDir}/main.js`);
	}

	private async getPluginMainJsHash(): Promise<string> {
		const mainJsPath = this.getPluginMainJsPath();
		try {
			const mainJs = await this.app.vault.adapter.readBinary(mainJsPath);
			return generateHash(mainJs);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.warn("Unable to hash plugin main.js for token refresh jitter", {
				path: mainJsPath,
				error: message,
			});
			return `${this.manifest.id}:${this.manifest.version}`;
		}
	}

	async onload() {
		// Detect leaked plugin instances from a previous onunload() that
		// crashed or was skipped. We track active instance IDs on a
		// window-level Set: each load adds an ID, each clean unload
		// removes it. A non-empty set at load time means a previous
		// lifecycle did not finish teardown, which surfaces as stale
		// WebSocket subscribers, duplicate event listeners, orphaned
		// PostOffice deliveries, and other ghost-plugin symptoms. Loud
		// error is the point — silent leaks used to manifest as
		// flaky test runs days later.
		const w = window as any;
		if (!w.__relayInstances) w.__relayInstances = new Set<string>();
		const leaked: string[] = Array.from(w.__relayInstances);
		if (leaked.length > 0) {
			console.error(
				`[Relay] leaked plugin instance(s) from a previous lifecycle: ${leaked.join(", ")}. ` +
				`Previous onunload() did not complete — expect stale listeners, ` +
				`duplicate WebSocket subscribers, and ghost state. ` +
				`Reload Obsidian to recover.`,
			);
		}
		this._instanceId = Math.random().toString(36).slice(2, 10);
		w.__relayInstances.add(this._instanceId);

		this.appId = (this.app as any).appId;
		setPluginRequestConfig({ pluginId: this.manifest.id });
		const start = moment.now();
		RelayInstances.set(this, "plugin");
		this.timeProvider = new DefaultTimeProvider();
		this.register(() => {
			this.timeProvider.destroy();
		});

		setActiveTracker(this.promises);
		this.promises.setDefaultOwner(`plugin:${this._instanceId}`);

		let onloadComplete!: () => void;
		trackPromise(
			`plugin:onload:${this._instanceId}`,
			new Promise<void>((resolve) => {
				onloadComplete = resolve;
			}),
		);

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
		initializeMetrics(
			this.app,
			(ref) => this.registerEvent(ref),
			(el, type, callback) => this.registerDomEvent(el, type, callback),
		);
		// While the page is hidden, the PostOffice delivery timer can be throttled
		// or suspended, so a pending batch may sit undelivered. On returning to the
		// foreground, poke the PostOffice to re-evaluate and flush anything that
		// was waiting out a throttled timer, rather than waiting for it to wake.
		if (typeof document !== "undefined") {
			this.registerDomEvent(document, "visibilitychange", () => {
				if (document.visibilityState === "visible") {
					PostOffice.peekInstance()?.tick();
				}
			});
		}
		this.notifier = new ObsidianNotifier();

		this.debug = curryLog("[System 3][Relay]", "debug");
		this.log = curryLog("[System 3][Relay]", "log");
		this.warn = curryLog("[System 3][Relay]", "warn");
		this.error = curryLog("[System 3][Relay]", "error");

		this.log("Plugin started", { version: this.manifest.version });

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
		this.register(
			flagManager.subscribe((manager) => {
				this.setMetadataHealthFeatureEnabled(
					manager.getFlag(flag.enableMetadataHealthNotice),
				);
			}),
		);

		this.savingFlagPolyfill = new SavingFlagPolyfill(Vault.prototype);
		this.register(
			flagManager.subscribe((manager) => {
				if (this._unloading) return;
				this.savingFlagPolyfill?.setEnabled(
					manager.getFlag(flag.enableSavingFlagPolyfill),
				);
			}),
		);
		this.savingFlagPolyfill.setEnabled(
			flagManager.getFlag(flag.enableSavingFlagPolyfill),
		);

		// Initialize HSM disk recording if enabled
		if (flags().enableHSMRecording) {
			const hsmRecordingPath = normalizePath(
				`${this.app.vault.configDir}/plugins/${this.manifest.id}/hsm-recording.jsonl`,
			);
			initializeHSMRecording(
				new ObsidianFileAdapter(this.app.vault),
				this.timeProvider,
				hsmRecordingPath,
			);
			this.register(() => stopHSMRecording());
			this.log("HSM recording enabled", { path: hsmRecordingPath });
		}

		this.settingsTab = new LiveSettingsTab(this.app, this);
		this.addRibbonIcon("satellite", "Relay", () => {
			this.openSettings();
		});

		// Initialize update manager
		this.updateManager = new UpdateManager(
			this as unknown as PluginWithVersion,
			this.timeProvider,
			this.releaseSettings,
		);

		// Feature flags are user-facing — always available. The modal hides
		// dangerous flags unless debugging is on.
		this.addCommand({
			id: "toggle-feature-flags",
			name: "Show feature flags",
			callback: () => {
				const modal = new FeatureFlagToggleModal(this.app);
				this.openModals.push(modal);
				modal.open();
			},
		});
		this.addCommand({
			id: "show-release-manager",
			name: "Show releases",
			callback: () => {
				this.openReleaseManager();
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

		this.register(
			this.debugSettings.subscribe((settings) => {
				if (settings.debugging) {
					this.enableDebugging();
					this.removeCommand("enable-debugging");
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
					this.removeCommand("show-debug-info");
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

		this.addCommand({
			id: "enable-user-attribution",
			name: "Enable user attribution highlighting",
			editorCheckCallback: (checking, editor) => {
				if (isUserAttributionOn(editor)) return false;
				if (!checking) toggleUserAttribution(editor);
				return true;
			},
		});
		this.addCommand({
			id: "disable-user-attribution",
			name: "Disable user attribution highlighting",
			editorCheckCallback: (checking, editor) => {
				if (!isUserAttributionOn(editor)) return false;
				if (!checking) toggleUserAttribution(editor);
				return true;
			},
		});

		this.addCommand({
			id: "register-host",
			name: "Register self-hosted server",
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

		// Register handler for update availability changes
		this.register(this.updateManager.subscribe(() => {
			const newRelease = this.updateManager.getNewRelease();
			if (newRelease) {
				// Add release notes command when an update is available.
				this.removeCommand("update-plugin");
				this.removeCommand("show-update-release");
				this.addCommand({
					id: "show-update-release",
					name: `Show update release (${this.version} → ${newRelease.tag_name})`,
					callback: () => {
						this.openReleaseManager(newRelease.tag_name);
					},
				});
				this.log(`Update available: v${this.version} → ${newRelease.tag_name}`);
			} else {
				// Remove update commands when no update is available
				this.removeCommand("update-plugin");
				this.removeCommand("show-update-release");
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
		this.relayDebugAPI = new RelayDebugAPI(this);
		this.deviceManager = new DeviceManager(
			this.appId,
			this.loginManager,
		);
		setDeviceManagementConfig({
			vaultId: this.appId,
			deviceId: this.deviceManager.getDeviceId(),
		});
		this._hsmStore = new HSMStore(this.appId);
		this.sharedFolders = new SharedFolders(
			this.relayManager,
			this.vault,
			this._createSharedFolder.bind(this),
			this.folderSettings,
			this._hsmStore,
			this.hashStore,
			this.timeProvider,
			this.appId,
		);

		// Register the sync-status view factory before the workspace layout
		// is restored. Obsidian restores leaves during boot; leaves of an
		// unregistered type fall back to a placeholder and the pane wouldn't
		// come back after a restart.
		this.registerView(
			VIEW_TYPE_SYNC_STATUS,
			(leaf) =>
				new SyncStatusView(leaf, {
					sharedFolders: this.sharedFolders,
					timeProvider: this.timeProvider,
					debugAPI: this.relayDebugAPI,
					onReviewHeldDeletions: (folder) =>
						this.gatedDeletions?.present(sharedFolderGateView(folder)),
				}),
		);

		const tokenRefreshJitterSeed = await this.getPluginMainJsHash();
		this.tokenStore = new LiveTokenStore(
			this.loginManager,
			this.timeProvider,
			vaultName,
			this.deviceManager.getDeviceId(),
			3,
			tokenRefreshJitterSeed,
		);

		this.networkStatus = new NetworkStatus(this.timeProvider, HEALTH_URL);

		this.backgroundSync = new BackgroundSync(
			this.loginManager,
			this.timeProvider,
			this.sharedFolders,
			3, // concurrency
		);

		if (!this.loginManager.setup()) {
			new Notice("Please sign in to use relay");
		}

		this.app.workspace.onLayoutReady(() => {
			if (this._unloading) return;

			detachSyncStatusViews(this.app.workspace);

			// Ensure the sync-status pane has a leaf so its icon shows in the
			// right-sidebar tab strip like Search/Bookmarks/etc. Not focused,
			// so it doesn't steal attention on startup.
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				void leaf.setViewState({
					type: VIEW_TYPE_SYNC_STATUS,
					active: false,
				});
			}

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
					this.relayManager.offline();
					this.sharedFolders.forEach((folder) => folder.disconnect());
					this._liveViews.goOffline();
				});
				this.networkStatus.addEventListener("online", () => {
					this.tokenStore.start();
					this.relayManager.online();
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
						if (folder.relayId && folder.connected && !folder.localOnly) {
							menu.addItem((item) => {
								item
									.setTitle("Relay: Sync")
									.setIcon("folder-sync")
									.onClick(() => {
										void openSyncStatusView(
											this.app.workspace,
											folder,
											this.timeProvider,
										);
										void folder.resync().catch((error) => {
											if (isDestroyedError(error)) {
												return;
											}
											this.warn("Relay: Resync failed", error);
										});
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
			onloadComplete();
		});
	}

	private setMetadataHealthFeatureEnabled(enabled: boolean): void {
		if (this._unloading) return;

		if (!enabled) {
			this.destroyMetadataHealthFeature();
			return;
		}

		if (!this.metadataHealth) {
			this.metadataHealth = new MetadataHealth(
				this.app.metadataCache,
				this.timeProvider,
			);
			this.metadataHealth.start();
		}

		if (!this.metadataHealthSidebarNotice) {
			const metadataHealth = this.metadataHealth;
			this.metadataHealthSidebarNotice = new MetadataHealthSidebarNoticeMount(
				this.app.workspace,
				metadataHealth,
			);
		}
	}

	private destroyMetadataHealthFeature(): void {
		this.metadataHealthSidebarNotice?.destroy();
		this.metadataHealthSidebarNotice = null;
		this.metadataHealth?.destroy();
		this.metadataHealth = null;
	}

	private _createSharedFolder(
		path: string,
		guid: string,
		relayId?: string,
		authoritative?: boolean,
		remote?: RemoteSharedFolder,
	): SharedFolder {
		// Validate guid before creating settings (prevents invalid UUIDs from being persisted)
		if (!guid || !S3RN.validateUUID(guid)) {
			throw new Error(`Cannot create shared folder: invalid guid "${guid}"`);
		}
		if (relayId && !S3RN.validateUUID(relayId)) {
			throw new Error(`Cannot create shared folder: invalid relayId "${relayId}"`);
		}

		// Initialize settings with pattern matching syntax
		const folderSettings = new NamespacedSettings<SharedFolderSettings>(
			this.settings,
			`sharedFolders/[guid=${guid}]`,
		);
		const settings: SharedFolderSettings = { guid: guid, path: path };
		if (relayId) {
			settings["relay"] = relayId;
		}
		void folderSettings.update((current) => {
			return {
				...current,
				path,
				guid,
				...(relayId ? { relay: relayId } : {}),
				...{
					sync: current.sync ? current.sync : SyncSettingsManager.defaultFlags,
				},
			};
		}, true).catch((error) => {
			if (this._unloading) return;
			const message = error instanceof Error ? error.message : String(error);
			this.warn(`Failed to persist shared folder settings for ${path}: ${message}`);
		});

		const folder = new SharedFolder(
			this.appId,
			guid,
			path,
			this.loginManager,
			this.vault,
			this.app.metadataCache,
			this.fileManager,
			this.tokenStore,
			this.relayManager,
			this.hashStore,
			this.backgroundSync,
			folderSettings,
			this._hsmStore,
			this.timeProvider,
			relayId,
			authoritative,
			remote,
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
		withFlag(flag.enableDeviceManagement, () => {
			this.deviceManager.register();
		});
	}

	async openSettings(path: string = "/") {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const setting = (this.app as any).setting;
		await setting.open();
		await setting.openTabById("system3-relay");
		this.settingsTab.navigateTo(path);
	}

	openReleaseManager(version?: string) {
		const modal = new ReleaseManager(this.app, this, version);

		const app = this.app as any;
		const setting = app.setting;
		setting.close();

		this.openModals.push(modal);
		modal.open();
	}

	openGithubRelease(release?: Release | string): void {
		let target: Release | string | undefined = release;
		if (typeof release === "string" && release.trim()) {
			target =
				this.updateManager.findReleaseByVersion(release.trim()) ??
				release.trim();
		}
		window.open(this.updateManager.getReleaseUrl(target), "_blank");
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
		this.gatedDeletions = new GatedDeletionController({
			openModal: (view, actions) =>
				new GatedDeletionModal(this.app, view, actions).openHandle(),
			notifyDisconnected: (view) => {
				new Notice(
					`"${view.name}" is disconnected. Reconnect to decide on its held deletions.`,
					8000,
				);
			},
		});
		this.register(() => {
			this.gatedDeletions?.destroy();
			this.gatedDeletions = null;
		});

		// Watch each shared folder for its outbound delete gate closing on a
		// held burst. A false→true edge opens the decision modal — for a
		// fresh burst and for a burst rehydrated at load — while the gate
		// staying closed after a dismissal never reopens it on its own.
		const watchedGates = new WeakSet<SharedFolder>();
		const lastGated = new WeakMap<SharedFolder, boolean>();
		const watchFolderGate = (folder: SharedFolder) => {
			if (watchedGates.has(folder)) return;
			watchedGates.add(folder);
			const view = sharedFolderGateView(folder);
			const check = () => {
				const gated = folder.deletionsGated;
				const wasGated = lastGated.get(folder) ?? false;
				lastGated.set(folder, gated);
				if (gated && !wasGated) this.gatedDeletions?.present(view);
			};
			folder.onDestroy(folder.subscribe({}, check));
			check();
		};
		this.register(
			this.sharedFolders.subscribe(() => {
				this.sharedFolders.forEach(watchFolderGate);
			}),
		);
		this.sharedFolders.forEach(watchFolderGate);

		this.folderNavDecorations = new FolderNavigationDecorations(
			this.vault,
			this.app.workspace,
			this.sharedFolders,
			this.backgroundSync,
			(folder) => this.gatedDeletions?.present(sharedFolderGateView(folder)),
		);
		this.folderNavDecorations.refresh();

		this.resourceMeter = new ResourceMeterMount(this.app.workspace, this.sharedFolders);

		this.addSettingTab(this.settingsTab);

		const workspaceLog = curryLog("[Live][Workspace]", "log");

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				workspaceLog("file-open");
				plugin._liveViews.refresh("file-open");
				if (file instanceof TFile) {
					sendDiagnosticToHSM(file, { type: 'OBSIDIAN_FILE_OPENED', path: file.path });
				}
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
					if (folder.folderHSM) {
						// Membership classification is the machine's job; the
						// origin discriminator inside notifyVaultCreate keeps
						// Obsidian's startup create replay from laundering
						// into user intent.
						const alreadyShared = folder.notifyVaultCreate(tfile);
						if (alreadyShared) {
							folder.whenReady()
								.then((folder) => {
									folder.getFile(tfile);
								})
								.catch((error) => {
									if (isDestroyedError(error)) {
										return;
									}
									this.warn(
										"folder ready failed after file create",
										error,
									);
								});
						}
						return;
					}
					// Legacy (non-HSM) path: a known file materializes
					// immediately; a genuinely-new file's registration settles
					// for a debounce window so a short-lived atomic-write temp
					// file vanishes before it is place-held and uploaded.
					if (folder.notifyVaultCreateLegacy(tfile)) {
						folder.whenReady()
							.then((folder) => {
								folder.getFile(tfile);
							})
							.catch((error) => {
								if (isDestroyedError(error)) {
									return;
								}
								this.warn("folder ready failed after file create", error);
							});
					}
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.queueVaultDelete(file, vaultLog);
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
				if (routeVaultRename(file, oldPath, fromFolder, toFolder)) {
					vaultLog("Rename", file.path, oldPath);
					this._liveViews.refresh("rename");
					if (fromFolder && toFolder) {
						this.folderNavDecorations.quickRefresh();
					} else {
						this.folderNavDecorations.refresh();
					}
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", async (tfile) => {
				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					vaultLog("Modify", tfile.path);
					const file = folder.proxy.getFile(tfile);
					if (file && isSyncFile(file)) {
						if (!(tfile instanceof TFile)) {
							vaultLog(
								"Skipping SyncFile modify -- event did not receive a TFile",
								tfile.path,
							);
						} else {
							vaultLog("Modify SyncFile", {
								path: tfile.path,
								virtualPath: file.path,
								guid: file.guid,
								mtime: tfile.stat.mtime,
								size: tfile.stat.size,
							});
							file.noteLocalModify(tfile.stat);
							void file.sync().catch((error) => {
								if (isRetryableS3Error(error)) {
									void folder.backgroundSync
										.enqueueRetryableSync(file, error)
										.catch((retryError) => {
											vaultLog("Binary file retry failed", retryError);
										});
									return;
								}
								vaultLog("Binary file sync failed", error);
							});
						}
					}

					// Send only genuinely external changes to the document HSM.
					if (
						file &&
						isDocument(file) &&
						file.hsm &&
						tfile instanceof TFile
					) {
						try {
							await file.handleDiskChange();
						} catch (e) {
							vaultLog("Failed to send DISK_CHANGED to HSM", e);
						}
					}

					// Dataview race condition
					this.timeProvider.setTimeout(() => {
						this.app.metadataCache.trigger("resolve", tfile);
					}, 10);
				}
			}),
		);

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;

		/** Route a diagnostic event to the HSM for the given file (if it's a Relay document). */
		const sendDiagnosticToHSM = (file: TFile, event: any) => {
			try {
				const folder = plugin.sharedFolders.lookup(file.path);
				if (folder) {
					const doc = folder.proxy.getFile(file);
					if (doc && isDocument(doc) && doc.hsm) {
						doc.hsm.send(event);
					}
				}
			} catch (e) {
				plugin.debug('Error sending diagnostic event:', e);
			}
		};

		const captureEditorContentForHSM = (file: TFile, contents: string) => {
			try {
				const folder = plugin.sharedFolders.lookup(file.path);
				if (folder) {
					const doc = folder.proxy.getFile(file);
					if (doc && isDocument(doc) && doc.hsm) {
						doc.hsm.captureEditorText(contents);
					}
				}
			} catch (e) {
				plugin.debug('Error capturing editor content:', e);
			}
		};

		getPatcher().patch(MarkdownView.prototype, {
			// When this is called, the active editors haven't yet updated.
			onUnloadFile(old: any) {
				return function (this: MarkdownView, file: TFile) {
					if (file instanceof TFile) {
						try {
							if (typeof this.getViewData === 'function') {
								captureEditorContentForHSM(file, this.getViewData());
							}
						} catch {
							// If Obsidian cannot provide view data here, keep
							// the last CM6 snapshot already held by the HSM.
						}
						sendDiagnosticToHSM(file, { type: 'OBSIDIAN_FILE_UNLOADED', path: file.path });
					}
					// @ts-ignore
					return old.call(this, file);
				};
			},
		});

		const TextFileViewPrototype = Object.getPrototypeOf(MarkdownView.prototype);
		getPatcher().patch(TextFileViewPrototype, {
			setViewData(old: any) {
				return function (this: any, data: string, clear: boolean) {
					// Universal disk→CRDT ingest point for every TextFileView
					// subclass (markdown, canvas, kanban, …). Obsidian calls
					// setViewData synchronously inside loadFileInternal before
					// the editor is populated and before Relay emits
					// ACQUIRE_LOCK, so sending the data to the HSM here lets
					// the three-way merge consult the authoritative disk text
					// even when the open race orders ACQUIRE_LOCK before
					// OBSIDIAN_LOAD_FILE_INTERNAL's post-await dispatch.
					//
					// `__relaySaving` is set by integrations that push CRDT
					// content back into the view; skipping the event in that
					// case prevents a reflection loop where our own write is
					// treated as fresh disk content.
					if (!this.__relaySaving) {
						try {
							const file = this.file;
							if (file instanceof TFile) {
								const folder = plugin.sharedFolders.lookup(file.path);
								if (folder) {
									const doc = folder.proxy.getFile(file);
									if (doc && isDocument(doc) && doc.hsm) {
										// Note text is LF everywhere past this
										// boundary.
										doc.hsm.send({
											type: 'OBSIDIAN_SET_VIEW_DATA',
											data: normalizeNoteText(data),
											clear,
											diskReload:
												this.__relayLoading === "reload" ? true : undefined,
										});
									}
								}
							}
						} catch (e) {
							plugin.debug('Error in setViewData patch:', e);
						}
					}
					return old.call(this, data, clear);
				};
			},
			loadFileInternal(old: any) {
				return async function (this: any, file: TFile, isInitialLoad: boolean) {
					// Mark the critical section: view.file has already been
					// reassigned by the caller; view.data is still stale until
					// setData runs inside the original call. The getViewData
					// patch above throws while this flag is set.
					this.__relayLoading = isInitialLoad ? "initial" : "reload";

					// Capture state before calling original
					const dirty = this.dirty;
					const lastSavedData = this.lastSavedData;
					const isPlaintext = this.isPlaintext;

					// Call original (may trigger three-way merge internally)
					let result;
					try {
						result = await old.call(this, file, isInitialLoad);
					} finally {
						// Clear the guard before any post-load reads (below and
						// elsewhere). Cleared in finally so a thrown original
						// doesn't leave the view permanently unreadable.
						this.__relayLoading = false;
					}

						// After original completes, send a diagnostic-only event if this is a Relay file
						try {
							const folder = plugin.sharedFolders.lookup(file.path);
							if (folder) {
								const doc = folder.proxy.getFile(file);
								if (doc && isDocument(doc) && doc.hsm) {
									// Read disk content only to compute diagnostic flags.
									// Normalize both sides so platform EOLs never
									// register as content changes.
									const diskContent = normalizeNoteText(
										await plugin.app.vault.read(file),
									);
									const contentChanged =
										(typeof lastSavedData === "string"
											? normalizeNoteText(lastSavedData)
											: lastSavedData) !== diskContent;
									const willMerge = dirty && contentChanged && isPlaintext;

									doc.hsm.send({
									type: 'OBSIDIAN_LOAD_FILE_INTERNAL',
										isInitialLoad,
										dirty,
										contentChanged,
										willMerge,
									});

								// OBSIDIAN_THREE_WAY_MERGE remains a supported diagnostic
								// event in the HSM, but open-time reconciliation should
								// use disk/CRDT state rather than reading the editor
								// buffer directly during load.
							}
						}
					} catch (e) {
						// Don't let diagnostic failures break normal operation
						plugin.debug('Error sending diagnostic event:', e);
					}

					return result;
				};
			},
		});

		getPatcher().patch(this.app.vault, {
			process(old: any) {
				return async function (
					this: any,
					tfile: any,
					fn: (data: string) => string,
					options: any,
				) {
					try {
						const folder = plugin.sharedFolders.lookup(tfile.path);
						if (folder) {
							const file = folder.proxy.getFile(tfile);
							if (tfile instanceof TFile && file && isDocument(file)) {
								const hsm = file.hsm;
								if (hsm) {
									await hsm.registerMachineEdit(fn);
								}
							}
						}
					} catch (e: any) {
						plugin.log(e);
					}

					return old.call(this, tfile, fn, options);
				};
			},
		});

		this.patchWebviewer();

		{
			const registeredFolderGuids = new Set<string>();
			const registerSyncStatusCommands = () => {
				this.sharedFolders.forEach((folder) => {
					if (registeredFolderGuids.has(folder.guid)) return;
					registeredFolderGuids.add(folder.guid);
					this.addCommand({
						id: `show-sync-status-${folder.guid}`,
						name: `Show sync status: ${folder.name}`,
						callback: () => {
							void openSyncStatusView(
								this.app.workspace,
								folder,
								this.timeProvider,
							);
						},
					});
				});
			};
			this.register(this.sharedFolders.subscribe(registerSyncStatusCommands));
		}

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
			this.openReleaseManager(version);
		});

		this.backgroundSync.start();
		this.updateManager.start();
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
		this._unloading = true;
		const teardownStep = (name: string, fn: () => void) => {
			this.debug(`[onunload] ${name}`);
			try {
				fn();
			} catch (error) {
				const e = error as { message?: string; stack?: string };
				console.error(
					`[Relay] onunload failed at step: ${name}: ${e?.message ?? error}\n${e?.stack ?? ""}`,
				);
				// Do NOT rethrow. A single step's failure must not abort the
				// rest of onunload; every later step represents a distinct
				// resource (timers, IDB connections, the PostOffice singleton,
				// log buffer, leak-detection set).
			}
		};
		setActiveTracker(null);
		this.promises.destroy();
		this.promises = null as any;
		teardownStep("pendingVaultDeleteFlush", () => {
			if (this.pendingVaultDeleteFlush !== null) {
				window.clearTimeout(this.pendingVaultDeleteFlush);
				this.pendingVaultDeleteFlush = null;
			}
			this.pendingVaultDeletes = [];
		});
		// Clean up debug API globals
		teardownStep("relayDebugAPI.destroy", () => {
			this.relayDebugAPI?.destroy();
		});
		this.relayDebugAPI = null as any;

		teardownStep("savingFlagPolyfill.disarm", () => {
			this.savingFlagPolyfill?.disarm();
		});
		this.savingFlagPolyfill = null;

		// Cleanup all monkeypatches and destroy the singleton
		teardownStep("Patcher.destroy", () => {
			Patcher.destroy();
		});

		teardownStep("metadataHealthFeature.destroy", () => {
			this.destroyMetadataHealthFeature();
		});

		teardownStep("folderNavDecorations.destroy", () => {
			this.folderNavDecorations?.destroy();
		});
		this.folderNavDecorations = null as any;

		teardownStep("resourceMeter.destroy", () => {
			this.resourceMeter?.destroy();
		});
		this.resourceMeter = null;

		teardownStep("detachLeavesOfType", () => {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_DIFFERENCES);
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_SYNC_STATUS);
		});

		// Explicitly destroy the update manager
		if (this.updateManager) {
			teardownStep("updateManager.destroy", () => {
				this.updateManager.destroy();
			});
			this.updateManager = null as any;
		}

		teardownStep("liveViews.destroy", () => {
			this._liveViews?.destroy();
		});
		this._liveViews = null as any;

		teardownStep("relayManager.destroy", () => {
			this.relayManager?.destroy();
		});
		this.relayManager = null as any;

		teardownStep("deviceManager.destroy", () => {
			this.deviceManager?.destroy();
		});
		this.deviceManager = null as any;

		teardownStep("tokenStore.stop", () => {
			this.tokenStore?.stop();
		});
		teardownStep("tokenStore.clearState", () => {
			this.tokenStore?.clearState();
		});
		teardownStep("tokenStore.destroy", () => {
			this.tokenStore?.destroy();
		});
		this.tokenStore = null as any;

		teardownStep("networkStatus.stop", () => {
			this.networkStatus?.stop();
		});
		teardownStep("networkStatus.destroy", () => {
			this.networkStatus?.destroy();
		});
		this.networkStatus = null as any;

		teardownStep("openModals.close", () => {
			this.openModals.forEach((modal) => {
				modal.close();
			});
		});
		this.openModals.length = 0;

		teardownStep("sharedFolders.destroy", () => {
			this.sharedFolders?.destroy();
		});
		this.sharedFolders = null as any;

		// Flush pending HSM writes and close the database after SharedFolders
		// are destroyed. Capture the store reference locally before clearing
		// the field so async cleanup cannot be skipped.
		const hsmStoreRef = this._hsmStore;
		teardownStep("hsmStore.destroy", () => {
			const p = hsmStoreRef?.destroy() ?? Promise.resolve();
			trackAsyncCleanup(
				p,
				`plugin:teardown:hsmStore.destroy:${this._instanceId}`,
			);
		});
		this._hsmStore = null as any;

		teardownStep("settingsTab.destroy", () => {
			this.settingsTab?.destroy();
		});
		this.settingsTab = null as any;

		teardownStep("loginManager.destroy", () => {
			this.loginManager?.destroy();
		});
		this.loginManager = null as any;

		teardownStep("backgroundSync.destroy", () => {
			this.backgroundSync?.destroy();
		});
		this.backgroundSync = null as any;

		teardownStep("hashStore.destroy", () => {
			this.hashStore.destroy();
		});
		this.hashStore = null as any;

		teardownStep("workspace.updateOptions", () => {
			this.app?.workspace.updateOptions();
		});
		this.app = null as any;
		this.fileManager = null as any;
		this.manifest = null as any;
		this.vault = null as any;

		teardownStep("debugSettings.destroy", () => {
			this.debugSettings.destroy();
		});
		this.debugSettings = null as any;
		teardownStep("folderSettings.destroy", () => {
			this.folderSettings.destroy();
		});
		this.folderSettings = null as any;

		// Destroy FeatureFlagManager before destroying featureSettings
		teardownStep("FeatureFlagManager.destroy", () => {
			FeatureFlagManager.destroy();
		});

		teardownStep("featureSettings.destroy", () => {
			this.featureSettings.destroy();
		});
		this.featureSettings = null as any;
		teardownStep("releaseSettings.destroy", () => {
			this.releaseSettings.destroy();
		});
		this.releaseSettings = null as any;
		teardownStep("loginSettings.destroy", () => {
			this.loginSettings.destroy();
		});
		this.loginSettings = null as any;
		teardownStep("endpointSettings.destroy", () => {
			this.endpointSettings.destroy();
		});
		this.endpointSettings = null as any;
		teardownStep("settings.destroy", () => {
			this.settings.destroy();
		});
		this.settings = null as any;

		this.interceptedUrls.length = 0;
		teardownStep("PostOffice.destroy", () => {
			PostOffice.destroy();
		});

		this.notifier = null as any;

		teardownStep("auditTeardown", () => {
			auditTeardown();
		});
		teardownStep("flushLogs", () => {
			flushLogs();
		});
		teardownStep("timeProvider.destroy", () => {
			this.timeProvider?.destroy();
		});
		this.timeProvider = null as any;
		this.promises = null as any;

		// Clear our instance ID from the leak-detection set LAST — if
		// anything above throws, we leave the ID in place so the next
		// load surfaces it as a leak. The pre-clear warning at the top
		// of onload() turns this into an actionable signal.
		(window as any).__relayInstances?.delete(this._instanceId);
	}

	async loadSettings() {
		this.settings.load();
	}

	async saveSettings() {
		await this.settings.save();
	}
}
