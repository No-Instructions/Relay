import {
	TFile,
	TFolder,
	type DataWriteOptions,
	type FileStats,
	type TAbstractFile,
	type Vault,
} from "obsidian";
import { dirname } from "path-browserify";
import { desktopAttachmentIO } from "./AttachmentIO";
import {
	CasePathHolds,
	DiskSlotTakenError,
	assertFreeOnDisk,
	findMaterializeConflict,
	probeDiskSpelling,
	type CasePathHold,
} from "./casePaths";

/** The identity a write is made for, at its virtual path in the folder. */
export interface DiskIdentity {
	readonly guid: string;
	readonly path: string;
}

/** What the boundary needs from the shared folder it writes for. */
export interface FolderDiskHost {
	readonly vault: Vault;
	/** The vault path of a virtual path, normalized. */
	vaultPath(vpath: string): string;
	/** False once the folder is torn down; nothing is written after that. */
	alive(): boolean;
	/** Move a file for a server rename, with link updates and no prompt. */
	renameFile(file: TAbstractFile, vaultPath: string): Promise<void>;
	warn(message: string): void;
	log(message: string): void;
}

/** A staged attachment ready to take a file's place; `commit` puts it there. */
export interface Replacement {
	mtime: number;
	size: number;
	/** The vault path the replacement lands at. */
	path: string;
	commit(): Promise<void>;
}

/**
 * The one way the sync engine writes inside a shared folder. Callers name
 * an identity and supply content; where the bytes may land, and whether they
 * still may by the time the disk is reached, is decided here.
 *
 * A case-insensitive disk resolves spellings that differ only in letter
 * case to one object, while membership and the vault index keep them apart.
 * Every write that would put a new object on disk first asks the disk how
 * it spells the path (see casePaths): a component reached only through
 * another spelling, or an object the index has not caught up with, holds
 * the write back, and the hold is recorded for the explorer and the banner.
 * A caller's own reasons to stand down are given as a predicate and asked
 * again right before the write, after every suspension that made room for
 * them to change.
 */
export class FolderDisk {
	/**
	 * Paths kept apart from another spelling that reaches the same disk
	 * object: remote changes kept off disk, and local files kept out of
	 * membership. Each is re-evaluated on every tree sync.
	 */
	readonly holds = new CasePathHolds();

	constructor(private readonly host: FolderDiskHost) {}

	private get vault(): Vault {
		return this.host.vault;
	}

	/** The vault path of a virtual path; the folder root for "/". */
	private target(vpath: string): string {
		return this.host.vaultPath(vpath).replace(/\/+$/, "");
	}

	/** Record a hold, saying why once per cause. */
	hold(hold: CasePathHold): void {
		if (!this.holds.hold(hold)) return;
		const cause = {
			"case-alias": `${hold.blockedBy} exists on disk under another spelling`,
			occupied: `another file is indexed at ${hold.blockedBy}`,
			unindexed: `${hold.blockedBy} exists on disk before the vault has indexed it`,
			"shared-slot": `it reaches the same disk object as ${hold.blockedBy}`,
		}[hold.reason];
		const held =
			hold.direction === "materialize"
				? "remote change held off disk"
				: "publication held";
		this.host.warn(`[${hold.path}] ${held}: ${cause}`);
	}

	private holdSlot(vpath: string, taken: DiskSlotTakenError): void {
		this.hold({
			path: vpath,
			direction: "materialize",
			reason: taken.reason,
			blockedBy: taken.blockedBy,
		});
	}

	/** The object the vault index holds at a virtual path. */
	indexed(vpath: string): TAbstractFile | null {
		return this.vault.getAbstractFileByPath(this.target(vpath));
	}

	/**
	 * Whether a remote change may create a disk object at `vpath`, or move
	 * `source` there (see findMaterializeConflict). A refused change is held,
	 * and a later tree sync retries it.
	 */
	async mayMaterialize(vpath: string, source?: TAbstractFile): Promise<boolean> {
		const conflict = await findMaterializeConflict(
			this.vault,
			this.target(vpath),
			source,
		);
		if (conflict) {
			this.hold({ path: vpath, direction: "materialize", ...conflict });
			return false;
		}
		this.holds.release("materialize", vpath);
		return true;
	}

	/**
	 * Make a directory, and the directories above it, where the index holds
	 * none. Vault refuses a directory whose own name aliases an existing one
	 * but makes one beneath a directory reached through another spelling,
	 * inside that other object, so the disk is asked first. A directory the
	 * index holds already is left alone; one that another writer finishes
	 * first counts as made.
	 */
	async mkdir(vpath: string): Promise<void> {
		const target = this.target(vpath);
		if (this.vault.getAbstractFileByPath(target) instanceof TFolder) return;
		const spelling = await probeDiskSpelling(this.vault.adapter, target);
		if (spelling.kind === "alias") {
			throw new DiskSlotTakenError(target, spelling.at, "case-alias");
		}
		for (const prefix of prefixes(target)) {
			const existing = this.vault.getAbstractFileByPath(prefix);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`${prefix} is a file, so no directory can be made beneath it`);
			try {
				await this.vault.createFolder(prefix);
			} catch (error) {
				if (this.vault.getAbstractFileByPath(prefix) instanceof TFolder) continue;
				if (await this.vault.adapter.exists(prefix, true)) continue;
				throw error;
			}
		}
	}

	/**
	 * Create a note for an identity whose file the index does not hold. Null
	 * when the disk holds the path back, when a file appeared there meanwhile,
	 * or when the caller's predicate says no once the disk has been asked.
	 * The disk is asked about the whole path before any directory is made,
	 * so a refused note leaves no directory behind.
	 */
	async create(
		file: DiskIdentity,
		contents: string,
		acceptsWrite: () => boolean = () => true,
	): Promise<TFile | null> {
		const vpath = file.path;
		const target = this.target(vpath);
		const spelling = await probeDiskSpelling(this.vault.adapter, target);
		if (spelling.kind === "alias") {
			this.holdSlot(vpath, new DiskSlotTakenError(target, spelling.at, "case-alias"));
			return null;
		}
		if (this.vault.getAbstractFileByPath(target)) return null;
		if (spelling.kind === "exact") {
			this.holdSlot(vpath, new DiskSlotTakenError(target, target, "unindexed"));
			return null;
		}
		try {
			await this.mkdir(dirname(vpath));
		} catch (error) {
			if (!(error instanceof DiskSlotTakenError)) throw error;
			this.holdSlot(vpath, error);
			return null;
		}
		// The file can appear, and the caller change its mind, while the
		// directory is made.
		if (this.vault.getAbstractFileByPath(target)) return null;
		if (!this.host.alive() || file.path !== vpath || !acceptsWrite()) return null;
		const created = await this.vault.create(target, contents);
		this.holds.release("materialize", vpath);
		return created;
	}

	/**
	 * Write a note the index holds. The handle must still be the object the
	 * index holds at its path: a handle whose file was replaced would write
	 * into the replacement. Nothing suspends between the predicate and the
	 * write.
	 */
	async modify(
		handle: TFile,
		contents: string,
		options?: DataWriteOptions,
		acceptsWrite: () => boolean = () => true,
	): Promise<boolean> {
		this.assertCurrent(handle);
		if (!this.host.alive() || !acceptsWrite()) return false;
		await this.vault.modify(handle, contents, options);
		return true;
	}

	async append(handle: TFile, contents: string): Promise<void> {
		this.assertCurrent(handle);
		await this.vault.append(handle, contents);
	}

	private assertCurrent(handle: TFile): void {
		const indexed = this.vault.getAbstractFileByPath(handle.path);
		if (indexed && indexed !== handle) {
			throw new Error(`${handle.path} cannot be written: the index holds another file there`);
		}
	}

	/**
	 * Write text through the adapter, at the path the index holds for the
	 * identity or, when it holds none, at a path the disk holds nothing at.
	 * Throws DiskSlotTakenError, and records the hold, when the disk holds
	 * the path under another spelling or ahead of the index.
	 */
	async write(file: DiskIdentity, contents: string): Promise<void> {
		await this.vault.adapter.write(await this.slot(file), contents);
	}

	/** As `write`, for bytes. Resolves to the vault path written. */
	async writeBinary(
		file: DiskIdentity,
		contents: ArrayBuffer,
		options?: DataWriteOptions,
	): Promise<string> {
		const target = await this.slot(file);
		await this.vault.adapter.writeBinary(target, contents, options);
		return target;
	}

	private async slot(file: DiskIdentity): Promise<string> {
		const target = this.target(file.path);
		if (this.vault.getAbstractFileByPath(target)) return target;
		await this.assertFree(file.path, target);
		return target;
	}

	private async assertFree(vpath: string, target: string): Promise<void> {
		try {
			await assertFreeOnDisk(this.vault.adapter, target);
		} catch (error) {
			if (error instanceof DiskSlotTakenError) this.holdSlot(vpath, error);
			throw error;
		}
	}

	/**
	 * Move `source` to the path membership gives `file`, making the
	 * destination directory first. False, with the move held, when the disk
	 * holds the destination back — before the directory is made, and again
	 * after, since the destination can be taken meanwhile.
	 */
	async move(
		file: DiskIdentity,
		source: TAbstractFile,
		onDirectoryMade?: (vpath: string) => void,
	): Promise<boolean> {
		const vpath = file.path;
		if (!(await this.mayMaterialize(vpath, source))) return false;
		const directory = dirname(vpath);
		if (source instanceof TFile && !this.indexed(directory)) {
			try {
				await this.mkdir(directory);
			} catch (error) {
				if (!(error instanceof DiskSlotTakenError)) throw error;
				this.holdSlot(vpath, error);
				return false;
			}
			onDirectoryMade?.(directory);
			if (!(await this.mayMaterialize(vpath, source))) return false;
		}
		await this.host.renameFile(source, this.target(vpath));
		return true;
	}

	/**
	 * Stage a downloaded attachment against the file it replaces. `expected`
	 * is what the destination looked like when the download began; a
	 * destination that changed since keeps its bytes. The returned commit
	 * asks the disk again before it moves anything.
	 */
	async prepareReplacement(
		file: DiskIdentity,
		partial: string,
		expected: FileStats | null,
	): Promise<Replacement> {
		const vpath = file.path;
		const destination = this.target(vpath);
		const adapter = this.vault.adapter;
		const stat = await adapter.stat(partial);
		if (!stat) throw new Error("Partial attachment is missing");
		const current = await adapter.stat(destination);
		if (current?.mtime !== expected?.mtime || current?.size !== expected?.size) {
			throw new Error("Attachment changed during download; local file was preserved");
		}
		const io = await desktopAttachmentIO(this.vault);
		// The portable adapter cannot replace a destination by rename.
		const contents = current && !io ? await adapter.readBinary(partial) : undefined;
		const mtime = contents ? Date.now() : stat.mtime;
		let committed = false;
		return {
			mtime,
			size: stat.size,
			path: destination,
			commit: async () => {
				if (committed) throw new Error("Attachment replacement already committed");
				committed = true;
				if (!this.host.alive() || file.path !== vpath) {
					throw new Error("Attachment moved before replacement");
				}
				const latest = await adapter.stat(destination);
				if (latest?.mtime !== current?.mtime || latest?.size !== current?.size) {
					throw new Error("Attachment changed before replacement; local file was preserved");
				}
				if (!this.vault.getAbstractFileByPath(destination)) {
					await this.assertFree(vpath, destination);
				}
				if (contents) return adapter.writeBinary(destination, contents, { mtime });
				if (current && io) {
					return io.fs.promises.rename(io.fullPath(partial), io.fullPath(destination));
				}
				return adapter.rename(partial, destination);
			},
		};
	}
}

/** Every prefix of a vault path, outermost first, ending with the path itself. */
function prefixes(path: string): string[] {
	const parts = path.split("/");
	return parts.map((_part, i) => parts.slice(0, i + 1).join("/"));
}
