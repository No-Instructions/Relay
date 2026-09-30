import type { DataAdapter, TAbstractFile, Vault } from "obsidian";

/**
 * Key under which spellings collide when they differ only in letter case or
 * in how accented letters are composed: the names every case-insensitive
 * filesystem Relay runs on (APFS, NTFS, FAT) resolves to one object. Rarer
 * foldings, such as ß against ss, differ between filesystems and are left
 * apart.
 */
export function foldPathCase(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

/**
 * How the disk resolves a vault path:
 * - `absent`: some component is missing, so nothing exists at the path;
 * - `exact`: every component exists under exactly the given spelling;
 * - `alias`: the component `at` exists only under a different spelling, so
 *   any write through the path would land in an object with another name.
 */
export type DiskSpelling =
	| { kind: "absent" }
	| { kind: "exact" }
	| { kind: "alias"; at: string };

/**
 * Resolve a vault path against the disk one component at a time, outermost
 * first. Obsidian's case-sensitive existence check compares only the final
 * name against its directory listing, so an ancestor reached through another
 * spelling passes it; every component has to be asked on its own. On a
 * case-sensitive disk every component that exists is exact.
 */
export async function probeDiskSpelling(
	adapter: Pick<DataAdapter, "exists">,
	path: string,
): Promise<DiskSpelling> {
	const parts = path.split("/");
	for (let depth = 1; depth <= parts.length; depth++) {
		const prefix = parts.slice(0, depth).join("/");
		if (await adapter.exists(prefix, true)) continue;
		return (await adapter.exists(prefix))
			? { kind: "alias", at: prefix }
			: { kind: "absent" };
	}
	return { kind: "exact" };
}

/**
 * A rename Obsidian performs in place on a case-insensitive disk: within one
 * directory, to a name that differs only in letter case. The comparison is
 * the one the adapter makes before it renames over an existing object.
 */
export function isCaseOnlyRename(from: string, to: string): boolean {
	const directory = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
	return (
		from !== to &&
		directory(from) === directory(to) &&
		from.toLowerCase() === to.toLowerCase()
	);
}

/** What keeps a remote change from putting an object at a vault path. */
export interface MaterializeConflict {
	reason: "case-alias" | "occupied" | "unindexed";
	/** The vault path whose object holds the slot. */
	blockedBy: string;
}

/**
 * Why a remote change may not create an object at `target`, or move `source`
 * there; null when it may. A case-insensitive disk resolves spellings that
 * differ only in letter case to one object while membership and the vault
 * index keep them apart, so a write through another spelling lands in
 * whatever object holds that slot. The change conflicts while any component
 * of the target exists on disk only under another spelling, and while an
 * object other than `source` — indexed, or on disk before the index knows
 * it — holds the target itself. A rename of `source` within its directory
 * that changes only letter case does not conflict: Obsidian performs it in
 * place.
 */
export async function findMaterializeConflict(
	vault: Pick<Vault, "adapter" | "getAbstractFileByPath">,
	target: string,
	source?: TAbstractFile,
): Promise<MaterializeConflict | null> {
	const spelling = await probeDiskSpelling(vault.adapter, target);
	const indexed = vault.getAbstractFileByPath(target);
	if (spelling.kind === "alias") {
		// The source must still be the object at its own path: a handle whose
		// file was deleted and replaced would rename the replacement.
		const renamesInPlace =
			spelling.at === target &&
			source !== undefined &&
			vault.getAbstractFileByPath(source.path) === source &&
			isCaseOnlyRename(source.path, target);
		return renamesInPlace ? null : { reason: "case-alias", blockedBy: spelling.at };
	}
	if (indexed && indexed !== source) return { reason: "occupied", blockedBy: target };
	if (spelling.kind === "exact" && !indexed) {
		return { reason: "unindexed", blockedBy: target };
	}
	return null;
}

/**
 * Whether two spellings reach one disk object. They must fold together
 * (foldPathCase), both must resolve on the disk, and the disk must reach one
 * of them through another spelling: an aliased ancestor alone does not make
 * the full paths one object, and two exact spellings are two objects.
 */
async function reachOneObject(
	adapter: Pick<DataAdapter, "exists">,
	a: string,
	b: string,
): Promise<boolean> {
	if (foldPathCase(a) !== foldPathCase(b)) return false;
	if (!(await adapter.exists(a)) || !(await adapter.exists(b))) return false;
	return (
		(await probeDiskSpelling(adapter, a)).kind === "alias" ||
		(await probeDiskSpelling(adapter, b)).kind === "alias"
	);
}

/**
 * The first of `variants` — vault paths that fold together with `path` —
 * that the disk resolves to the same object as `path`, or null when every
 * variant is a distinct object.
 */
export async function findVariantSharingObject(
	adapter: Pick<DataAdapter, "exists">,
	path: string,
	variants: readonly string[],
): Promise<string | null> {
	for (const variant of variants) {
		if (await reachOneObject(adapter, path, variant)) return variant;
	}
	return null;
}

/** Thrown by a write that would put a new file where the disk already holds one. */
export class DiskSlotTakenError extends Error {
	constructor(
		readonly path: string,
		readonly blockedBy: string,
		readonly reason: "case-alias" | "unindexed",
	) {
		super(
			reason === "case-alias"
				? `${path} cannot be created while ${blockedBy} exists on disk under another spelling`
				: `${path} cannot be created over a file the vault has not indexed yet`,
		);
		this.name = "DiskSlotTakenError";
	}
}

/**
 * Refuse to write a file the vault index does not hold unless the disk holds
 * nothing there either. A raw adapter write resolves its path through the
 * disk: through another spelling it lands inside an object that carries
 * another name, and at an exact path it overwrites a file that arrived before
 * the index learned of it.
 */
export async function assertFreeOnDisk(
	adapter: Pick<DataAdapter, "exists">,
	path: string,
): Promise<void> {
	const spelling = await probeDiskSpelling(adapter, path);
	if (spelling.kind === "alias") {
		throw new DiskSlotTakenError(path, spelling.at, "case-alias");
	}
	if (spelling.kind === "exact") throw new DiskSlotTakenError(path, path, "unindexed");
}

/** A path that cannot take its place until another spelling stops holding its slot. */
export interface CasePathHold {
	/** The virtual path waiting to reach disk, or waiting to be published. */
	path: string;
	/**
	 * `materialize`: a remote create or move is kept off this disk.
	 * `publish`: a local file is kept out of shared membership.
	 */
	direction: "materialize" | "publish";
	/** What holds the slot: a vault path on disk, or a committed virtual path. */
	blockedBy: string;
	/**
	 * `case-alias`: a component exists on disk under another spelling.
	 * `occupied`: the vault index holds a different object at the path.
	 * `unindexed`: the exact path exists on disk before the index knows it.
	 * `shared-slot`: a committed path of another spelling reaches the same object.
	 */
	reason: "case-alias" | "occupied" | "unindexed" | "shared-slot";
}

/** What the UI reads of a folder's holds. */
export type CasePathHoldsView = Pick<CasePathHolds, "get" | "holdsWithin" | "subscribe">;

/** The paths one shared folder is holding back, by direction. */
export class CasePathHolds {
	private holds = new Map<string, CasePathHold>();
	private listeners = new Set<() => void>();

	private static key(direction: CasePathHold["direction"], path: string): string {
		return `${direction}\0${path}`;
	}

	/** Called whenever a hold is added, changes cause, or is dropped. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		this.listeners.forEach((listener) => listener());
	}

	/** Record a hold. True when the path was not already held for this cause. */
	hold(hold: CasePathHold): boolean {
		const key = CasePathHolds.key(hold.direction, hold.path);
		const previous = this.holds.get(key);
		this.holds.set(key, hold);
		const changed =
			previous?.blockedBy !== hold.blockedBy || previous.reason !== hold.reason;
		if (changed) this.changed();
		return changed;
	}

	release(direction: CasePathHold["direction"], path: string): void {
		if (this.holds.delete(CasePathHolds.key(direction, path))) this.changed();
	}

	get(direction: CasePathHold["direction"], path: string): CasePathHold | undefined {
		return this.holds.get(CasePathHolds.key(direction, path));
	}

	/** Whether a hold in this direction covers the path or anything beneath it. */
	holdsWithin(direction: CasePathHold["direction"], path: string): boolean {
		for (const hold of this.holds.values()) {
			if (
				hold.direction === direction &&
				(hold.path === path || hold.path.startsWith(path + "/"))
			) {
				return true;
			}
		}
		return false;
	}

	holding(direction: CasePathHold["direction"]): boolean {
		for (const hold of this.holds.values()) {
			if (hold.direction === direction) return true;
		}
		return false;
	}

	/** Drop every hold the predicate rejects. */
	retain(keep: (hold: CasePathHold) => boolean): void {
		let dropped = false;
		for (const [key, hold] of this.holds) {
			if (!keep(hold)) {
				this.holds.delete(key);
				dropped = true;
			}
		}
		if (dropped) this.changed();
	}

	list(): CasePathHold[] {
		return Array.from(this.holds.values());
	}
}
