export interface FeatureFlags {
	enableUpdateYDocFromDiskBuffer: boolean;
	enableUploadOnShare: boolean;
	enableDocumentStatus: boolean;
	enableDebugFileTag: boolean;
	enableNewLinkFormat: boolean;
	enableDeltaLogging: boolean;
	enableHTTPSync: boolean;
	enableDocumentServer: boolean;
}

export const FeatureFlagDefaults: FeatureFlags = {
	enableUpdateYDocFromDiskBuffer: false,
	enableUploadOnShare: false,
	enableDocumentStatus: false,
	enableDebugFileTag: false,
	enableNewLinkFormat: false,
	enableDeltaLogging: false,
	enableHTTPSync: false,
	enableDocumentServer: false,
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
