export interface FeatureFlags {
	enableDocumentStatus: boolean;
	enableNewLinkFormat: boolean;
	enableDiffLinkStatus: boolean;
	enableDeltaLogging: boolean;
	enableNetworkLogging: boolean;
	enableVerifyUploads: boolean;
	enableDiscordLogin: boolean;
	enableDeviceManagement: boolean;
	enableHSMRecording: boolean;
	enableDraftMode: boolean;
	enableResourceMeter: boolean;
	enableFolderIdbMigration: boolean;
	enableSelectiveSubdocQuery: boolean;
}

export type FeatureFlagCategory = "labs" | "debugging" | "danger";

export interface FeatureFlagSchemaEntry {
	default: boolean;
	category: FeatureFlagCategory;
	title: string;
	description: string;
}

/**
 * Schema for every supported feature flag.
 *
 * - `default` — value applied when the flag is missing from settings.
 * - `category`:
 *   - `labs` — opt-in user-facing features. Always visible.
 *   - `debugging` — diagnostic instrumentation. Only visible when
 *     debugging mode is enabled.
 *   - `danger` — changes persistence, alters sync semantics, or relies on
 *     unreleased server behavior. Only visible when debugging is enabled,
 *     and rendered inside a marked "Danger zone" section.
 * - `title` — human-readable name shown as the row heading.
 * - `description` — one-line summary shown next to the toggle.
 *
 * Flags are only surfaced in the UI when they appear here. Adding a flag to
 * `FeatureFlags` without a schema entry is a type error.
 */
export const FeatureFlagSchema: {
	[K in keyof FeatureFlags]: FeatureFlagSchemaEntry;
} = {
	enableDocumentStatus: {
		default: false,
		category: "debugging",
		title: "Show document connectivity indicator",
		description:
			"Show per-document connected and connecting state in the file explorer, plus active transfer highlighting.",
	},
	enableNewLinkFormat: {
		default: false,
		category: "labs",
		title: "Scope links to shared folders",
		description:
			"Generate link text for shared-folder files by name when unique, or by relative path when names collide.",
	},
	enableDiffLinkStatus: {
		default: false,
		category: "labs",
		title: "Show link status in diff view",
		description:
			"Decorate links in conflict diffs as resolved or missing using Obsidian's link cache.",
	},
	enableDiscordLogin: {
		default: false,
		category: "labs",
		title: "Discord OAuth sign-in",
		description:
			"Include Discord in the available OAuth providers on the sign-in screen.",
	},
	enableDeviceManagement: {
		default: true,
		category: "danger",
		title: "Device and vault registration",
		description:
			"Register this device and vault with the server, then send their IDs with API requests.",
	},
	enableResourceMeter: {
		default: false,
		category: "labs",
		title: "Show hibernation stats",
		description:
			"Show active document slot usage and documents waiting to resume in the file explorer toolbar.",
	},
	enableDeltaLogging: {
		default: false,
		category: "debugging",
		title: "CRDT and merge diagnostics",
		description:
			"Log Yjs deltas, diff operations, byte mismatches, and merge payload details.",
	},
	enableNetworkLogging: {
		default: false,
		category: "debugging",
		title: "HTTP response logging",
		description:
			"Log HTTP status, method, URL, and response bodies from Relay network requests.",
	},
	enableVerifyUploads: {
		default: false,
		category: "debugging",
		title: "Verify uploaded attachments",
		description:
			"After attachment sync, confirm the remote object exists and re-upload if it is missing.",
	},
	enableHSMRecording: {
		default: false,
		category: "debugging",
		title: "Merge state-machine recording",
		description:
			"Write MergeHSM transition records to the vault-local JSONL recording file.",
	},
	enableDraftMode: {
		default: false,
		category: "labs",
		title: "Draft mode",
		description:
			"Use the editor action as a publish pause/resume control so local edits can stay unpublished.",
	},
	enableFolderIdbMigration: {
		default: false,
		category: "danger",
		title: "Migrate folder IndexedDB",
		description:
			"Copy folder-level IndexedDB stores into the app-scoped folder database on next open.",
	},
	enableSelectiveSubdocQuery: {
		default: false,
		category: "danger",
		title: "Selective subdoc index query",
		description:
			"On reconnect, query the server only for locally committed document IDs. Requires server support.",
	},
};

export const FeatureFlagDefaults: FeatureFlags = (
	Object.keys(FeatureFlagSchema) as (keyof FeatureFlags)[]
).reduce((acc, key) => {
	acc[key] = FeatureFlagSchema[key].default;
	return acc;
}, {} as FeatureFlags);

export function isKeyOfFeatureFlags(key: string): key is keyof FeatureFlags {
	return key in FeatureFlagSchema;
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
