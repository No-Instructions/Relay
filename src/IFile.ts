export interface IFile {
	guid: string;
	path: string;
	move: (newPath: string) => void;
	connect: () => void;
	disconnect: () => void;
	destroy: () => void;
}

export interface Hashable {
	sha256: () => Promise<string>;
}
