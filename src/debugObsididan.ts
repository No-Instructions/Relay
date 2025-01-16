import { Notice, Vault } from "obsidian";
import type { IFileAdapter, INotifier } from "./debug";

export class ObsidianNotifier implements INotifier {
	notify(message: string) {
		new Notice(message);
	}
}

export class ObsidianFileAdapter implements IFileAdapter {
	constructor(private vault: Vault) {}

	async append(path: string, content: string) {
		return this.vault.adapter.append(path, content);
	}

	async stat(path: string) {
		return this.vault.adapter.stat(path);
	}

	async exists(path: string) {
		return this.vault.adapter.exists(path);
	}

	async remove(path: string) {
		return this.vault.adapter.remove(path);
	}

	async rename(oldPath: string, newPath: string) {
		return this.vault.adapter.rename(oldPath, newPath);
	}

	async write(path: string, content: string) {
		return this.vault.adapter.write(path, content);
	}

	async read(path: string) {
		return this.vault.adapter.read(path);
	}
}
