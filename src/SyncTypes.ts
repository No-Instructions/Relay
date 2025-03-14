import { getMimeType } from "./mimetypes";

export enum SyncType {
	Folder = "folder",
	Document = "markdown",
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

type FileMetas = ImageMeta | PDFMeta | AudioMeta | VideoMeta | FileMeta;

export type Meta = FolderMeta | DocumentMeta | FileMetas;

type SyncTypeToMeta = {
	[SyncType.Folder]: FolderMeta;
	[SyncType.Document]: FolderMeta;
	[SyncType.PDF]: PDFMeta;
	[SyncType.Image]: ImageMeta;
	[SyncType.Audio]: AudioMeta;
	[SyncType.Video]: VideoMeta;
	[SyncType.File]: FileMeta;
};

export function isDocumentMeta(meta?: Meta): meta is DocumentMeta {
	return meta?.type === SyncType.Document;
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

export class TypeRegistry {
	private protocols = new Map<SyncType, ProtocolSupport>();

	constructor(configs?: Array<[SyncType, ProtocolSupport]>) {
		configs = configs || TypeRegistry.defaults;
		configs.forEach(([type, config]) => this.protocols.set(type, config));
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
	];

	setEnabled(type: SyncType, enabled: boolean) {
		const config = this.protocols.get(type);
		if (config) {
			config.enabled = enabled;
		}
	}

	canSync(vpath: string, meta?: Meta): boolean {
		// For existing files, check meta
		if (meta) {
			const config = this.protocols.get(meta.type);
			if (!config) return false;
			return config.enabled && meta.version <= config.maxVersion;
		}

		// For new files, check path
		const mimetype = getMimeType(vpath);

		// Check if any type handles this mimetype
		for (const [, config] of this.protocols) {
			if (config.mimetypes.includes(mimetype)) {
				return config.enabled;
			}
		}

		return false;
	}

	getTypeForPath(vpath: string): SyncType | null {
		const mimetype = getMimeType(vpath);

		for (const [type, config] of this.protocols) {
			if (config.mimetypes.includes(mimetype)) {
				return type;
			}
		}

		return null;
	}
}
