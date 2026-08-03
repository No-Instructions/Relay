import type { SharedFolder } from "./SharedFolder";

export interface IFile {
	guid: string;
	path: string;
	move: (newPath: string, sharedFolder: SharedFolder) => void;
	connect: () => Promise<boolean>;
	disconnect: () => void;
	cleanup: () => void | Promise<void>;
	destroy: () => void;
}

export interface HasMimeType {
	mimetype: string;
}
