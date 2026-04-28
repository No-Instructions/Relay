import { NamespacedSettings, Settings } from "./SettingsStorage";

export interface SyncCategory {
	enabled: boolean;
	extensions: string[];
	description: string;
	name: string;
	requiresStorage: boolean;
	canToggle: boolean;
}

export interface SyncFlags {
	images?: boolean;
	audio?: boolean;
	videos?: boolean;
	pdfs?: boolean;
	canvas?: boolean;
	bases?: boolean;
	otherTypes?: boolean;
}

export type SyncCategoryKey = keyof SyncFlags | "markdown";

interface TypeSettings {
	name: string;
	description: string;
	extensions: string[];
	defaultEnabled: boolean;
	requiresStorage: boolean;
}

export class SyncSettingsManager extends NamespacedSettings<
	Record<keyof SyncFlags, boolean>
> {
	private static readonly alwaysEnabledSchema: Record<"markdown", TypeSettings> = {
		markdown: {
			name: "Markdown",
			description: "Sync Markdown files (.md)",
			extensions: ["md"],
			defaultEnabled: true,
			requiresStorage: false,
		},
	};

	private static readonly schema: Record<keyof SyncFlags, TypeSettings> = {
		canvas: {
			name: "Canvas",
			description: "Sync Canvas files (.canvas)",
			extensions: ["canvas"],
			defaultEnabled: true,
			requiresStorage: false,
		},
		bases: {
			name: "Bases",
			description: "Sync Bases files (.base)",
			extensions: ["base"],
			defaultEnabled: true,
			requiresStorage: true,
		},
		images: {
			name: "Images",
			description:
				"Sync image files (.bmp, .png, .jpg, .jpeg, .gif, .svg, .webp, .avif)",
			extensions: ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"],
			defaultEnabled: true,
			requiresStorage: true,
		},
		audio: {
			name: "Audio",
			description:
				"Sync audio files (.mp3, .wav, .m4a, .3gp, .flac, .ogg, .oga, .opus)",
			extensions: ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"],
			defaultEnabled: true,
			requiresStorage: true,
		},
		videos: {
			name: "Videos",
			description: "Sync video files (.mp4, .webm, .ogv, .mov, .mkv)",
			extensions: ["mp4", "webm", "ogv", "mov", "mkv"],
			defaultEnabled: true,
			requiresStorage: true,
		},
		pdfs: {
			name: "PDFs",
			description: "Sync PDF files (.pdf)",
			extensions: ["pdf"],
			defaultEnabled: true,
			requiresStorage: true,
		},
		otherTypes: {
			name: "Other files",
			description: "Sync unsupported file types",
			extensions: [],
			defaultEnabled: false,
			requiresStorage: true,
		},
	};

	static readonly defaultFlags = Object.fromEntries(
		Object.entries(SyncSettingsManager.schema).map(([key, schema]) => [
			key,
			schema.defaultEnabled,
		]),
	) as Record<keyof SyncFlags, boolean>;

	constructor(
		settings: Settings<any>,
		path: string,
		public enabled = true,
	) {
		super(settings, path);
	}

	public isExtensionEnabled(path: string): boolean {
		const extension = path.split(".").pop() || "";
		const normalizedExt = extension.toLowerCase();

		if (normalizedExt === "md") return true;

		if (!this.enabled) {
			return false;
		}

		for (const [key, schema] of Object.entries(SyncSettingsManager.schema)) {
			const flagKey = key as keyof SyncFlags;
			const enabled = this.get()[flagKey] ?? schema.defaultEnabled;
			if (enabled && schema.extensions.includes(normalizedExt)) {
				return true;
			}
		}

		return (
			this.get().otherTypes ??
			SyncSettingsManager.schema.otherTypes.defaultEnabled
		);
	}

	public requiresStorage(path: string): boolean {
		const extension = path.split(".").pop() || "";
		const normalizedExt = extension.toLowerCase();

		if (normalizedExt === "md") return false;

		for (const schema of Object.values(SyncSettingsManager.schema)) {
			if (schema.extensions.includes(normalizedExt)) {
				return schema.requiresStorage;
			}
		}

		return SyncSettingsManager.schema.otherTypes.requiresStorage;
	}

	getCategory(key: SyncCategoryKey): SyncCategory {
		if (key === "markdown") {
			const schema = SyncSettingsManager.alwaysEnabledSchema[key];
			return {
				enabled: true,
				name: schema.name,
				description: schema.description,
				extensions: schema.extensions,
				requiresStorage: schema.requiresStorage,
				canToggle: false,
			};
		}

		const schema = SyncSettingsManager.schema[key];
		const enabled = this.get()[key] ?? schema.defaultEnabled;
		return {
			enabled,
			name: schema.name,
			description: schema.description,
			extensions: schema.extensions,
			requiresStorage: schema.requiresStorage,
			canToggle: true,
		};
	}

	getCategories(): Record<SyncCategoryKey, SyncCategory> {
		const categories = {
			markdown: this.getCategory("markdown"),
		} as Record<SyncCategoryKey, SyncCategory>;

		for (const key of Object.keys(SyncSettingsManager.schema)) {
			categories[key as keyof SyncFlags] = this.getCategory(
				key as keyof SyncFlags,
			);
		}

		return categories;
	}

	public async toggleCategory(
		category: keyof SyncFlags,
		enabled: boolean,
	): Promise<void> {
		await this.update((current) => {
			return {
				...current,
				[category]: enabled,
			};
		});
		this.log(`setting ${category} to ${enabled}`);
		this.notifyListeners();
	}

	public async resetToDefault(): Promise<void> {
		await this.update(() => {
			return { ...SyncSettingsManager.defaultFlags };
		});
	}
}
