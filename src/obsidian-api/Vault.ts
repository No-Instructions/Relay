"use strict";
import {
	App,
	FileSystemAdapter,
	TAbstractFile,
	TFolder,
	type DataAdapter,
} from "obsidian";
import { Observable } from "lib0/observable";
import path from "path-browserify";

// Ok, so we want to factor out the vault behavior...
// So a base vault should support registering and triggerings signals.
// Ideally the plugin would be able to run without obsidian...
// It might be really hard to do that without being able to replicate inotify and stuff...

export interface Vault extends Observable<string> {
	adapter: DataAdapter;
	get root(): string;
	getFiles(): TAbstractFile[];
	fullPath(name: string): string;
	createFolder(path: string): Promise<TFolder>;
	rename(file: TAbstractFile, newName: string): void;
	getFolderByPath(path: string): TFolder | null;
	getAbstractFileByPath(path: string): TAbstractFile | null;
}

export class VaultFacade extends Observable<string> implements Vault {
	app: App;
	adapter: DataAdapter;

	constructor(app: App) {
		super();
		this.app = app;
		this.adapter = app.vault.adapter;
	}

	public getName(): string {
		return this.app.vault.getName();
	}

	public get root(): string {
		const vaultRoot = (
			this.app.vault.adapter as FileSystemAdapter
		).getBasePath();
		return vaultRoot;
	}

	fullPath(name: string): string {
		return path.join(this.root, name);
	}

	getFiles(): TAbstractFile[] {
		return this.app.vault.getFiles();
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.app.vault.getAbstractFileByPath(path);
	}

	getFolderByPath(path: string): TFolder | null {
		const maybeFolder = this.app.vault.getAbstractFileByPath(path);
		if (maybeFolder instanceof TFolder) {
			return maybeFolder;
		}
		return null;
	}

	rename(file: TAbstractFile, newName: string) {
		this.app.vault.rename(file, newName);
	}

	createFolder(path: string): Promise<TFolder> {
		return this.app.vault.createFolder(path);
	}

	iterateFolders(fn: (folder: TFolder) => void) {
		function iterateFolders(folder: TFolder) {
			fn(folder);
			// Iterate over child folders
			folder.children.forEach((child) => {
				if (child instanceof TFolder) {
					iterateFolders(child);
				}
			});
		}

		const rootFolder: TFolder = this.app.vault.getRoot();
		iterateFolders(rootFolder);
	}
}
