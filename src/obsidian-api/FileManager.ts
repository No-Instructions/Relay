import type { App, TAbstractFile } from "obsidian";

export interface FileManager {
	renameFile(file: TAbstractFile, newName: string): Promise<void>;
}

export class FileManagerFacade implements FileManager {
	app: App;

	constructor(app: App) {
		this.app = app;
	}

	renameFile(file: TAbstractFile, newName: string): Promise<void> {
		return this.app.fileManager.renameFile(file, newName);
	}
}
