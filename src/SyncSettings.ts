import { NamespacedSettings, Settings } from "./SettingsStorage";

export interface SyncCategory {
	enabled: boolean;
	extensions: string[];
	description: string;
	name: string;
}

export interface SyncCategorySchema {
	name: string;
	description: string;
	extensions: string[];
	defaultEnabled: boolean;
}

export interface SyncFlags {
	images?: boolean;
	audio?: boolean;
	videos?: boolean;
	pdfs?: boolean;
	otherTypes?: boolean;
}

export class SyncSettingsManager extends NamespacedSettings<SyncFlags> {
	private static readonly schema: Record<keyof SyncFlags, SyncCategorySchema> =
		{
			images: {
				name: "Images",
				extensions: ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"],
				description:
					"Sync image files (.bmp, .png, .jpg, .jpeg, .gif, .svg, .webp, .avif)",
				defaultEnabled: true,
			},
			audio: {
				name: "Audio",
				extensions: ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"],
				description:
					"Sync audio files (.mp3, .wav, .m4a, .3gp, .flac, .ogg, .oga, .opus)",
				defaultEnabled: true,
			},
			videos: {
				name: "Videos",
				extensions: ["mp4", "webm", "ogv", "mov", "mkv"],
				description: "Sync video files (.mp4, .webm, .ogv, .mov, .mkv)",
				defaultEnabled: true,
			},
			pdfs: {
				name: "PDFs",
				extensions: ["pdf"],
				description: "Sync PDF files (.pdf)",
				defaultEnabled: true,
			},
			otherTypes: {
				name: "Other Files",
				extensions: [],
				description: "Sync unsupported file types",
				defaultEnabled: false,
			},
		};

	static readonly defaultFlags: SyncFlags = Object.fromEntries(
		Object.entries(SyncSettingsManager.schema).map(([key, schema]) => [
			key,
			schema.defaultEnabled,
		]),
	) as SyncFlags;

	constructor(
		settings: Settings<any>,
		path: string,
		private enabled = true,
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
			const enabled =
				this.get()[key as keyof SyncFlags] ?? schema.defaultEnabled;
			if (enabled && schema.extensions.includes(normalizedExt)) {
				return true;
			}
		}

		return (
			this.get().otherTypes ??
			SyncSettingsManager.schema.otherTypes.defaultEnabled
		);
	}

	getCategory(key: keyof SyncFlags): SyncCategory {
		const schema = SyncSettingsManager.schema[key];
		const enabled = this.get()[key] ?? schema.defaultEnabled;
		return {
			enabled,
			name: schema.name,
			description: schema.description,
			extensions: schema.extensions,
		};
	}

	getCategories(): Record<keyof SyncFlags, SyncCategory> {
		return Object.keys(SyncSettingsManager.schema).reduce(
			(acc, key) => {
				acc[key as keyof SyncFlags] = this.getCategory(key as keyof SyncFlags);
				return acc;
			},
			{} as Record<keyof SyncFlags, SyncCategory>,
		);
	}

	public async toggleCategory(
		category: keyof SyncFlags,
		enabled: boolean,
	): Promise<void> {
		await this.update((current) => {
			current[category] = enabled;
			return current;
		});
		this.log(`setting ${category} to ${enabled}`);
	}

	public async resetToDefault(): Promise<void> {
		await this.set(SyncSettingsManager.defaultFlags);
	}
}
