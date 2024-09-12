export interface FeatureFlags {
	enableUpdateYDocFromDiskBuffer: boolean;
	enableInvalidLinkDecoration: boolean;
	enableDiffResolution: boolean;
	enableDownloadOnAddToVault: boolean;
	enableUploadOnShare: boolean;
	enableDocumentStatus: boolean;
	enableFolderConnectionToggle: boolean;
}

export const FeatureFlagDefaults: FeatureFlags = {
	enableUpdateYDocFromDiskBuffer: false,
	enableInvalidLinkDecoration: false,
	enableDiffResolution: false,
	enableDownloadOnAddToVault: false,
	enableUploadOnShare: false,
	enableDocumentStatus: false,
	enableFolderConnectionToggle: false,
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
