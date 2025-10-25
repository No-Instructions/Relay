import { type SyncFlags, type SyncSettingsManager } from "./SyncSettings";
import { flags } from "./flagManager";
import { getMimeType } from "./mimetypes";
import { Observable } from "./observable/Observable";

export enum SyncType {
	Folder = "folder",
	Document = "markdown",
	Canvas = "canvas",
	Image = "image",
	PDF = "pdf",
	Audio = "audio",
	Video = "video",
	File = "file",
}

export type SyncFileType =
	| SyncType.Image
	| SyncType.PDF
	| SyncType.Audio
	| SyncType.Video
	| SyncType.File;

interface MetaBase {
	id: string;
	version: number;
	type: SyncType;
	hash?: string;
	synctime?: number;
	mimetype?: string;
}

export interface FolderMeta extends MetaBase {
	version: 0;
	type: SyncType.Folder;
}

export interface DocumentMeta extends MetaBase {
	version: 0;
	type: SyncType.Document;
}

export interface CanvasMeta extends MetaBase {
	version: 0;
	type: SyncType.Canvas;
}

interface BaseFileMeta extends MetaBase {
	version: 0;
	type: SyncFileType;
	mimetype: string;
	hash: string;
	synctime: number;
}

export interface ImageMeta extends BaseFileMeta {
	type: SyncType.Image;
}

export interface PDFMeta extends BaseFileMeta {
	type: SyncType.PDF;
}

export interface AudioMeta extends BaseFileMeta {
	type: SyncType.Audio;
}

export interface VideoMeta extends BaseFileMeta {
	type: SyncType.Video;
}

export interface FileMeta extends BaseFileMeta {
	type: SyncType.File;
}

export type FileMetas = ImageMeta | PDFMeta | AudioMeta | VideoMeta | FileMeta;

export type Meta = FolderMeta | DocumentMeta | FileMetas | CanvasMeta;

type SyncTypeToMeta = {
	[SyncType.Folder]: FolderMeta;
	[SyncType.Document]: DocumentMeta;
	[SyncType.Canvas]: CanvasMeta;
	[SyncType.PDF]: PDFMeta;
	[SyncType.Image]: ImageMeta;
	[SyncType.Audio]: AudioMeta;
	[SyncType.Video]: VideoMeta;
	[SyncType.File]: FileMeta;
};

export const SyncFlagToTypeMap: Record<keyof SyncFlags, SyncType> = {
	images: SyncType.Image,
	audio: SyncType.Audio,
	videos: SyncType.Video,
	pdfs: SyncType.PDF,
	otherTypes: SyncType.File,
};

export const SyncTypeToFlagMap: Record<SyncType, keyof SyncFlags | null> = {
	[SyncType.Document]: null, // Always enabled
	[SyncType.Canvas]: null, // Always enabled
	[SyncType.Folder]: null, // Always enabled
	[SyncType.Image]: "images",
	[SyncType.Audio]: "audio",
	[SyncType.Video]: "videos",
	[SyncType.PDF]: "pdfs",
	[SyncType.File]: "otherTypes",
};

export function isDocumentMeta(meta?: Meta): meta is DocumentMeta {
	return meta?.type === SyncType.Document;
}

export function isCanvasMeta(meta?: Meta): meta is DocumentMeta {
	return meta?.type === SyncType.Canvas;
}

export function isSyncFolderMeta(meta?: Meta): meta is FolderMeta {
	return meta?.type === SyncType.Folder;
}

export function isSyncFileMeta(meta?: Meta): meta is FileMeta {
	return meta?.type === SyncType.File;
}

export function isImageMeta(meta?: Meta): meta is ImageMeta {
	return meta?.type === SyncType.Image;
}

export function isPDFMeta(meta?: Meta): meta is PDFMeta {
	return meta?.type === SyncType.PDF;
}

export function isAudioMeta(meta?: Meta): meta is AudioMeta {
	return meta?.type === SyncType.Audio;
}

export function isVideoMeta(meta?: Meta): meta is VideoMeta {
	return meta?.type === SyncType.Video;
}

export function makeDocumentMeta(guid: string): DocumentMeta {
	return {
		version: 0,
		id: guid,
		type: SyncType.Document,
	};
}

export function makeCanvasMeta(guid: string): CanvasMeta {
	return {
		version: 0,
		id: guid,
		type: SyncType.Canvas,
	};
}

export function makeFolderMeta(guid: string): FolderMeta {
	return {
		version: 0,
		id: guid,
		type: SyncType.Folder,
	};
}

export function makeFileMeta<T extends SyncFileType>(
	type: T,
	guid: string,
	mimetype: string,
	hash: string,
	synctime?: number,
): SyncTypeToMeta[T] {
	if (!synctime) {
		synctime = Date.now();
	}
	return {
		version: 0,
		id: guid,
		type: type,
		mimetype,
		synctime,
		hash,
	} as SyncTypeToMeta[T];
}

interface ProtocolSupport {
	maxVersion: number;
	mimetypes: string[];
	enabled: boolean;
}

export class TypeRegistry extends Observable<TypeRegistry> {
	private protocols = new Map<SyncType, ProtocolSupport>();

	constructor(
		private syncSettings: SyncSettingsManager,
		private configs?: Array<[SyncType, ProtocolSupport]>,
	) {
		super();
		configs = configs || TypeRegistry.defaults;
		configs.forEach(([type, config]) => this.protocols.set(type, config));
		this.unsubscribes.push(
			syncSettings.subscribe((settings) => {
				this.updateFromSettings(settings);
			}),
		);
	}

	static defaults: Array<[SyncType, ProtocolSupport]> = [
		[
			SyncType.Folder,
			{
				maxVersion: 0,
				mimetypes: [],
				enabled: true,
			},
		],
		[
			SyncType.Document,
			{
				maxVersion: 0,
				mimetypes: ["text/markdown"],
				enabled: true,
			},
		],
		[
			SyncType.Image,
			{
				maxVersion: 0,
				mimetypes: [
					"image/png",
					"image/jpeg",
					"image/gif",
					"image/svg+xml",
					"image/webp",
					"image/avif",
					"image/bmp",
				],
				enabled: true,
			},
		],
		[
			SyncType.PDF,
			{
				maxVersion: 0,
				mimetypes: ["application/pdf"],
				enabled: true,
			},
		],
		[
			SyncType.Audio,
			{
				maxVersion: 0,
				mimetypes: [
					"audio/mpeg",
					"audio/wav",
					"audio/flac",
					"audio/mp4",
					"audio/x-m4a",
					"audio/ogg",
					"audio/opus",
				],
				enabled: true,
			},
		],
		[
			SyncType.Video,
			{
				maxVersion: 0,
				mimetypes: [
					"video/mp4",
					"video/webm",
					"video/ogg",
					"video/quicktime",
					"video/x-matroska",
				],
				enabled: true,
			},
		],
		[
			SyncType.Canvas,
			{
				maxVersion: 0,
				mimetypes: ["application/canvas+json"],
				enabled: true,
			},
		],
		[
			SyncType.File,
			{
				maxVersion: 0,
				mimetypes: ["application/octet-stream"],
				enabled: false,
			},
		],
	];

	setEnabled(type: SyncType, enabled: boolean) {
		const config = this.protocols.get(type);
		if (config) {
			this.protocols.set(type, { ...config, enabled: enabled });
		}
	}

	canSync(vpath: string, meta?: Meta): boolean {
		if (vpath.endsWith(".md")) return true;
		if (flags().enableCanvasSync) {
			if (vpath.endsWith(".canvas")) return true;
		}

		// For new folders
		const hasExtension = vpath.split("/").pop()?.includes(".");
		if (!hasExtension) {
			return true;
		}

		// For existing files, check meta
		if (meta) {
			const config = this.protocols.get(meta.type);
			if (!config) return false;
			return config.enabled && meta.version <= config.maxVersion;
		}

		// For new files, check path
		const type = this.getTypeForPath(vpath);
		return !!this.protocols.get(type)?.enabled;
	}

	private updateFromSettings(settings: Record<keyof SyncFlags, boolean>): void {
		Object.entries(SyncFlagToTypeMap).forEach(([flagKey, syncType]) => {
			this.setEnabled(syncType, settings[flagKey as keyof SyncFlags]);
		});
	}

	public getEnabledFileSyncTypes(): SyncType[] {
		// Documents and folders are always enabled

		const enabledTypes: SyncType[] = [];
		this.protocols.forEach((proto, syncType) => {
			if (proto?.enabled && syncType !== SyncType.Folder) {
				enabledTypes.push(syncType);
			}
		});

		return enabledTypes;
	}

	getTypeForPath(vpath: string): SyncType {
		const mimetype = getMimeType(vpath);

		for (const [type, config] of this.protocols) {
			if (config.mimetypes.includes(mimetype)) {
				if (!flags().enableCanvasSync && type === SyncType.Canvas) {
					return SyncType.File;
				}
				return type;
			}
		}

		return SyncType.File;
	}
}
