export interface FeatureFlags {
	enableUpdateYDocFromDiskBuffer: boolean;
	enableDownloadOnAddToVault: boolean;
	enableUploadOnShare: boolean;
	enableDocumentStatus: boolean;
	enableDocumentIdTag: boolean;
	enableNewLinkFormat: boolean;
}

export const FeatureFlagDefaults: FeatureFlags = {
	enableUpdateYDocFromDiskBuffer: false,
	enableDownloadOnAddToVault: false,
	enableUploadOnShare: false,
	enableDocumentStatus: false,
	enableDocumentIdTag: false,
	enableNewLinkFormat: false,
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
