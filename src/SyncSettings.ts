import { NamespacedSettings, Settings } from "./SettingsStorage";
import { flags } from "./flagManager";

export interface SyncCategory {
	enabled: boolean;
	extensions: string[];
	description: string;
	name: string;
}

export interface SyncFlags {
	images?: boolean;
	audio?: boolean;
	videos?: boolean;
	pdfs?: boolean;
	otherTypes?: boolean;
}

interface TypeSettings {
	name: string;
	description: string;
	extensions: string[];
	defaultEnabled: boolean;
}

export class SyncSettingsManager extends NamespacedSettings<
	Record<keyof SyncFlags, boolean>
> {
	private static readonly schema: Record<keyof SyncFlags, TypeSettings> = {
		images: {
			name: "Images",
			description:
				"Sync image files (.bmp, .png, .jpg, .jpeg, .gif, .svg, .webp, .avif)",
			extensions: ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"],
			defaultEnabled: true,
		},
		audio: {
			name: "Audio",
			description:
				"Sync audio files (.mp3, .wav, .m4a, .3gp, .flac, .ogg, .oga, .opus)",
			extensions: ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"],
			defaultEnabled: true,
		},
		videos: {
			name: "Videos",
			description: "Sync video files (.mp4, .webm, .ogv, .mov, .mkv)",
			extensions: ["mp4", "webm", "ogv", "mov", "mkv"],
			defaultEnabled: true,
		},
		pdfs: {
			name: "PDFs",
			description: "Sync PDF files (.pdf)",
			extensions: ["pdf"],
			defaultEnabled: true,
		},
		otherTypes: {
			name: "Other files",
			description: "Sync unsupported file types",
			extensions: [],
			defaultEnabled: false,
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

		if (flags().enableCanvasSync && normalizedExt === "canvas") return true;

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
