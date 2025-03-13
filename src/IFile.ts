export interface IFile {
	guid: string;
	path: string;
	move: (newPath: string) => void;
	connect: () => void;
	disconnect: () => void;
	cleanup: () => void;
	destroy: () => void;
}

export interface HasMimeType {
	mimetype: string;
}

export interface Hashable {
	sha256: () => Promise<string>;
}
