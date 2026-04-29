export interface FeatureFlags {
	enableDocumentStatus: boolean;
	enableNewLinkFormat: boolean;
	enableDeltaLogging: boolean;
	enableNetworkLogging: boolean;
	enableVerifyUploads: boolean;
	enableDiscordLogin: boolean;
	enableDeviceManagement: boolean;
	enableHSMRecording: boolean;
	enableDraftMode: boolean;
	enableNewSyncStatus: boolean;
	enableResourceMeter: boolean;
	enableFolderIdbMigration: boolean;
	enableSelectiveSubdocQuery: boolean;
}

export const FeatureFlagDefaults: FeatureFlags = {
	enableDocumentStatus: false,
	enableNewLinkFormat: false,
	enableDeltaLogging: false,
	enableNetworkLogging: false,
	enableVerifyUploads: false,
	enableDiscordLogin: false,
	enableDeviceManagement: true,
	enableHSMRecording: false,
	enableDraftMode: false,
	enableNewSyncStatus: false,
	enableResourceMeter: false,
	enableFolderIdbMigration: false,
	enableSelectiveSubdocQuery: false,
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
