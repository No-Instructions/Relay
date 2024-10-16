import type { IFile } from "./IFile";
import { v4 as uuidv4 } from "uuid";

export class SyncNothing implements IFile {
	guid: string;

	constructor(public path: string) {
		this.guid = uuidv4();
	}

	// No-op implementations
	move(_newPath: string): void {}
	connect(): void {}
	disconnect(): void {}
	destroy(): void {}
}
