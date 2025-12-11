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
