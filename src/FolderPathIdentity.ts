import { normalizePath, type TAbstractFile, type Vault } from "obsidian";
import { dirname } from "path-browserify";
import { SyncType, type Meta } from "./SyncTypes";
import { vaultPaths, type VaultPathResolver } from "./VaultPathResolver";

interface PathClaim {
	path: string;
	meta: Meta;
}

interface PathSlot {
	spellings: Set<string>;
	claims: PathClaim[];
}

export type PathResolution =
	| { kind: "available"; file: TAbstractFile | null }
	| { kind: "unindexed"; path: string }
	| { kind: "collision"; path: string; reason: string };

/**
 * Projects case-sensitive membership paths onto the vault's filesystem.
 * A spelling identifies a membership key; a TAbstractFile identifies the
 * local object. Neither a casing difference nor an index delay creates a
 * second local object. Remote keys remain unchanged on every platform.
 */
export class FolderPathIdentity {
	private slots: Map<string, PathSlot> | null = null;
	private readonly vaultPaths: VaultPathResolver;

	constructor(
		private readonly vault: Vault,
		private readonly root: () => string,
		private readonly readClaims: (visit: (meta: Meta, path: string) => void) => void,
		private readonly identityOf: (file: TAbstractFile) => string | undefined,
		private readonly isPending: (path: string) => boolean = () => false,
	) {
		this.vaultPaths = vaultPaths(vault);
	}

	initialize(): Promise<void> | undefined {
		const initializing = this.vaultPaths.initialize(this.root());
		return initializing?.then(() => this.invalidate());
	}

	invalidate(): void {
		this.slots = null;
	}

	key(path: string): string {
		return this.vaultPaths.key(path);
	}

	file(path: string): TAbstractFile | null {
		return this.vaultPaths.resolve(this.root() + path);
	}

	/** Return the remote spelling, including a known parent's spelling for a new child. */
	canonical(path: string): string {
		for (const prefix of this.prefixes(path).reverse()) {
			const slot = this.index().get(this.key(prefix));
			if (slot?.spellings.size === 1) {
				const spelling = slot.spellings.values().next().value as string;
				return spelling + path.slice(prefix.length);
			}
		}
		return path;
	}

	/** A pending local identity keeps its own key until its claim is resolved. */
	local(path: string): string {
		return this.isPending(path) ? path : this.canonical(path);
	}

	/** Keep a user's new basename while resolving the existing parent. */
	renameTarget(path: string): string {
		const parent = dirname(path);
		return parent === "/" ? path : this.local(parent) + path.slice(parent.length);
	}

	hasClaim(path: string): boolean {
		return (this.index().get(this.key(path))?.claims.length ?? 0) > 0;
	}

	claim(path: string): PathClaim | undefined {
		if (this.collision(path)) return undefined;
		const claims = this.index().get(this.key(path))?.claims;
		return claims?.length === 1 ? claims[0] : undefined;
	}

	/** Rechecked synchronously inside the membership publication transaction. */
	canClaim(path: string, guid: string): boolean {
		return this.publicationConflict(path, guid) === null;
	}

	publicationConflict(path: string, guid: string): Extract<PathResolution, { kind: "collision" }> | null {
		const collision = this.collision(path);
		if (collision) return collision;
		for (const prefix of this.prefixes(path)) {
			const slot = this.index().get(this.key(prefix));
			if (slot && !slot.spellings.has(prefix)) {
				return { kind: "collision", path: prefix, reason: "local and shared paths use different spellings for one filesystem location" };
			}
		}
		const claim = this.claim(path);
		return claim && (claim.path !== path || claim.meta.id !== guid)
			? { kind: "collision", path, reason: "another identity owns this shared path" }
			: null;
	}

	/**
	 * Resolves ownership before materialization or a move. Existing objects
	 * are adopted through their TAbstractFile; disk-only objects wait for the
	 * index. A distinct known GUID cannot take another owner's disk object.
	 */
	async resolve(path: string, guid: string, source?: TAbstractFile): Promise<PathResolution> {
		const initializing = this.initialize();
		if (initializing) await initializing;
		const collision = this.collision(path);
		if (collision) return collision;
		for (const prefix of this.prefixes(path)) {
			const file = this.file(prefix);
			if (!file) {
				const stat = await this.vault.adapter.stat(normalizePath(this.root() + prefix));
				if (!stat) continue;
				// Exact unindexed parents can be created ahead of the watcher;
				// a final object must be indexed before it can be adopted safely.
				if (prefix === path || stat.type !== "folder") return { kind: "unindexed", path: prefix };
			} else if (prefix === path) {
				const mismatch = this.checkIdentity(path, file, guid, source);
				if (mismatch) return mismatch;
			} else if (!("children" in file)) {
				return { kind: "collision", path: prefix, reason: "a file occupies the parent directory" };
			}
		}
		// Membership and vault events may land while a disk stat is pending.
		const latest = this.collision(path);
		if (latest) return latest;
		const file = this.file(path);
		return (file && this.checkIdentity(path, file, guid, source)) ?? { kind: "available", file };
	}

	private checkIdentity(path: string, file: TAbstractFile, guid: string, source?: TAbstractFile):
		Extract<PathResolution, { kind: "collision" }> | null {
		const claim = this.claim(path);
		if (claim && ((claim.meta.type === SyncType.Folder) !== ("children" in file))) {
			return { kind: "collision", path, reason: "membership and disk object have different types" };
		}
		const owner = this.identityOf(file);
		if ((source && file !== source) || (owner && owner !== guid)) {
			return { kind: "collision", path, reason: "another file identity owns this disk object" };
		}
		return null;
	}

	/** Preserve physical directory spelling for a new file or a rename. */
	diskTarget(path: string): string {
		return this.vaultPaths.target(this.root() + path);
	}

	collision(path: string): Extract<PathResolution, { kind: "collision" }> | null {
		for (const prefix of this.prefixes(path)) {
			const slot = this.index().get(this.key(prefix));
			if (slot && slot.spellings.size > 1) {
				return { kind: "collision", path: prefix, reason: "membership paths share one filesystem location" };
			}
		}
		return null;
	}

	private index(): Map<string, PathSlot> {
		if (this.slots) return this.slots;
		const slots = new Map<string, PathSlot>();
		this.readClaims((meta, path) => {
			for (const prefix of this.prefixes(path)) {
				const key = this.key(prefix);
				let slot = slots.get(key);
				if (!slot) {
					slot = { spellings: new Set(), claims: [] };
					slots.set(key, slot);
				}
				slot.spellings.add(prefix);
				if (prefix === path && !slot.claims.some(claim => claim.path === path)) slot.claims.push({ path, meta });
			}
		});
		return this.slots = slots;
	}

	private prefixes(path: string): string[] {
		const prefixes = [path];
		let parent = dirname(path);
		while (parent !== "/" && parent !== ".") {
			prefixes.unshift(parent);
			parent = dirname(parent);
		}
		return prefixes;
	}
}
