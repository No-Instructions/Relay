export interface FeatureFlags {
	enableDocumentStatus: boolean;
	enableNewLinkFormat: boolean;
	enableDeltaLogging: boolean;
	enableDocumentHistory: boolean;
	enableEditorTweens: boolean;
	enableNetworkLogging: boolean;
	enableCanvasSync: boolean;
	enableVerifyUploads: boolean;
	enableAutomaticDiffResolution: boolean;
	enableDiscordLogin: boolean;
	enableSelfManageHosts: boolean;
	enableToasts: boolean;
	enablePresenceAvatars: boolean;
	enableLiveEmbeds: boolean;
	enablePreviewViewHooks: boolean;
	enableMetadataViewHooks: boolean;
	enableKanbanView: boolean;
	enableDeviceManagement: boolean;

	// MergeHSM flags for incremental rollout
	/** Master flag: enable MergeHSM system (gates all other HSM flags) */
	enableMergeHSM: boolean;
	/** Enable HSM for idle mode (background sync, disk change detection) */
	enableMergeHSMIdleMode: boolean;
	/** Enable HSM for conflict detection (replaces checkStale) */
	enableMergeHSMConflictDetection: boolean;
	/** Enable HSM for active mode (editor sync) */
	enableMergeHSMActiveMode: boolean;
	/** Enable HSM shadow mode (run HSM in parallel, log divergences) */
	enableMergeHSMShadowMode: boolean;
	/** Enable HSM invariant checking (runtime validation) */
	enableMergeHSMInvariantChecks: boolean;
	/** Enable HSM recording (capture event traces) */
	enableMergeHSMRecording: boolean;
	/** Enable HSM visual debugger panel */
	enableMergeHSMDebugger: boolean;
}

export const FeatureFlagDefaults: FeatureFlags = {
	enableDocumentStatus: false,
	enableNewLinkFormat: false,
	enableDeltaLogging: false,
	enableDocumentHistory: false,
	enableEditorTweens: false,
	enableNetworkLogging: false,
	enableCanvasSync: false,
	enableVerifyUploads: false,
	enableAutomaticDiffResolution: true,
	enableDiscordLogin: false,
	enableSelfManageHosts: true,
	enableToasts: true,
	enablePresenceAvatars: true,
	enableLiveEmbeds: true,
	enablePreviewViewHooks: true,
	enableMetadataViewHooks: true,
	enableKanbanView: true,
	enableDeviceManagement: false,

	// MergeHSM flags - all disabled by default for safe rollout
	enableMergeHSM: false,
	enableMergeHSMIdleMode: false,
	enableMergeHSMConflictDetection: false,
	enableMergeHSMActiveMode: false,
	enableMergeHSMShadowMode: false,
	enableMergeHSMInvariantChecks: false,
	enableMergeHSMRecording: false,
	enableMergeHSMDebugger: false,
} as const;

export function isKeyOfFeatureFlags(key: string): key is keyof FeatureFlags {
	return key in FeatureFlagDefaults;
}

export type Flag = keyof FeatureFlags;

// Autogenerate flag object which can be used to select flags like this...
// withFlag(flag.enableInvalidLinkDecoration, () => {})
type KeysToValues<T> = { [K in keyof T]: K };
function createFlagObject<T>(): KeysToValues<T> {
	return new Proxy({} as KeysToValues<T>, {
		get: (target, prop) => prop,
	});
}
export const flag = createFlagObject<FeatureFlags>();
