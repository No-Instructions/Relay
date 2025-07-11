export interface FeatureFlags {
	enableUpdateYDocFromDiskBuffer: boolean;
	enableDocumentStatus: boolean;
	enableNewLinkFormat: boolean;
	enableDeltaLogging: boolean;
	enableHTTPSync: boolean;
	enableSyncMenu: boolean;
	enableDocumentServer: boolean;
	enableDocumentHistory: boolean;
	enableEditorTweens: boolean;
	enableSyncModal: boolean;
	enableDesyncPill: boolean;
	enableAttachmentSync: boolean;
	enableNetworkLogging: boolean;
	enableCanvasSync: boolean;
	enableVerifyUploads: boolean;
}

export const FeatureFlagDefaults: FeatureFlags = {
	enableUpdateYDocFromDiskBuffer: false,
	enableDocumentStatus: false,
	enableNewLinkFormat: false,
	enableDeltaLogging: false,
	enableHTTPSync: false,
	enableSyncMenu: true,
	enableDocumentServer: false,
	enableDocumentHistory: false,
	enableEditorTweens: false,
	enableSyncModal: false,
	enableDesyncPill: false,
	enableAttachmentSync: true,
	enableNetworkLogging: false,
	enableCanvasSync: false,
	enableVerifyUploads: false,
};

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
