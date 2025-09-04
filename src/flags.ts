export interface FeatureFlags {
	enableDocumentStatus: boolean;
	enableNewLinkFormat: boolean;
	enableDeltaLogging: boolean;
	enableHTTPSync: boolean;
	enableSyncMenu: boolean;
	enableDocumentServer: boolean;
	enableDocumentHistory: boolean;
	enableEditorTweens: boolean;
	enableSyncModal: boolean;
	enableAttachmentSync: boolean;
	enableNetworkLogging: boolean;
	enableCanvasSync: boolean;
	enableVerifyUploads: boolean;
	enableAutomaticDiffResolution: boolean;
	enableDiscordLogin: boolean;
	enableMicrosoftLogin: boolean;
	enableOIDCLogin: boolean;
	enableSelfManageHosts: boolean;
}

export const FeatureFlagDefaults: FeatureFlags = {
	enableDocumentStatus: false,
	enableNewLinkFormat: false,
	enableDeltaLogging: false,
	enableHTTPSync: false,
	enableSyncMenu: true,
	enableDocumentServer: false,
	enableDocumentHistory: false,
	enableEditorTweens: false,
	enableSyncModal: false,
	enableAttachmentSync: true,
	enableNetworkLogging: false,
	enableCanvasSync: false,
	enableVerifyUploads: false,
	enableAutomaticDiffResolution: false,
	enableDiscordLogin: false,
	enableMicrosoftLogin: true,
	enableOIDCLogin: false,
	enableSelfManageHosts: false,
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
