import type { SharedFolder } from "./SharedFolder";

export interface IFile {
	guid: string;
	path: string;
	move: (newPath: string, sharedFolder: SharedFolder) => void;
	connect: () => void;
	disconnect: () => void;
	cleanup: () => void;
	destroy: () => void;
}

export interface HasMimeType {
	mimetype: string;
}
