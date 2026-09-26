import { normalizePath, type DataAdapter, type TAbstractFile, type Vault } from "obsidian";
import { basename, dirname, join } from "path-browserify";

const resolvers = new WeakMap<Vault, VaultPathResolver>();

/** One filesystem interpretation shared by every consumer of a vault. */
export function vaultPaths(vault: Vault): VaultPathResolver {
	let resolver = resolvers.get(vault);
	if (!resolver) resolvers.set(vault, resolver = new VaultPathResolver(vault));
	return resolver;
}

export class VaultPathResolver {
	private insensitive: boolean | undefined;
	private initializing: Promise<void> | undefined;

	constructor(private readonly vault: Vault) {
		// This is the capability Obsidian's native adapter uses for rename.
		// Adapters without it are detected through their public exists API.
		const capability = (vault.adapter as DataAdapter & { insensitive?: boolean }).insensitive;
		this.insensitive = typeof capability === "boolean" ? capability : undefined;
	}

	initialize(root: string): Promise<void> | undefined {
		if (this.insensitive !== undefined) return;
		if (this.initializing) return this.initializing;
		const candidates = [
			...(this.vault.getAbstractFileByPath(root) ? [root] : []),
			...this.vault.getAllLoadedFiles().map(file => file.path),
		];
		const probe = candidates.find(path => /[a-zA-Z]/.test(basename(path)));
		if (!probe) return;
		const name = basename(probe);
		const alternate = normalizePath(join(dirname(probe), name.replace(/[a-zA-Z]/, letter =>
			letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
		)));
		return this.initializing = (async () => {
			this.insensitive = await this.vault.adapter.exists(alternate) &&
				!(await this.vault.adapter.exists(alternate, true));
		})().finally(() => { this.initializing = undefined; });
	}

	key(path: string): string {
		return this.insensitive ? path.toLowerCase() : path;
	}

	/** Exact spelling wins; a case alias returns the same TAbstractFile object. */
	resolve(path: string): TAbstractFile | null {
		path = normalizePath(path);
		const exact = this.vault.getAbstractFileByPath(path);
		if (exact || !this.insensitive) return exact;
		const vault = this.vault as Vault & {
			getAbstractFileByPathInsensitive?: (path: string) => TAbstractFile | null;
		};
		if (vault.getAbstractFileByPathInsensitive) return vault.getAbstractFileByPathInsensitive(path);
		return vault.getAllLoadedFiles().find(file => this.key(file.path) === this.key(path)) ?? null;
	}
}
