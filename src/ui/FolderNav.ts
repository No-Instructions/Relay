import {
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	Workspace,
	WorkspaceLeaf,
} from "obsidian";
import { SharedFolder, SharedFolders } from "../SharedFolder";
import type { ConnectionState } from "src/HasProvider";
import { Document } from "src/Document";
import Pill from "src/components/Pill.svelte";
import TextPill from "src/components/TextPill.svelte";
import { withAnyOf, withFlag } from "src/flagManager";
import { flag } from "src/flags";
import { isDocMeta, isDocument } from "src/SyncStore";
import type { IFile } from "src/SyncFile";

class SiblingWatcher {
	mutationObserver: MutationObserver | null;
	el: HTMLElement;

	constructor(el: HTMLElement, onceSibling: (el: HTMLElement) => void) {
		this.el = el;
		this.mutationObserver = new MutationObserver((mutationsList, observer) => {
			for (const mutation of mutationsList) {
				if (mutation.type === "childList") {
					if (el.nextSibling) {
						onceSibling(el);
						observer.disconnect();
					}
				}
			}
		});
		this.mutationObserver.observe(el.parentElement as HTMLElement, {
			childList: true,
			subtree: true,
		});
	}

	destroy() {
		this.mutationObserver?.disconnect();
		this.mutationObserver = null;
	}
}

interface TreeNode {
	el: HTMLElement;
}

interface FileItem extends TreeNode {
	el: HTMLElement;
	selfEl: HTMLElement;
}

interface FolderItem extends TreeNode {
	el: HTMLElement;
	selfEl: HTMLElement;
}

interface FileSystemVisitor<T> {
	visitFolder(
		folder: TFolder,
		item: FolderItem,
		storage?: T,
		sharedFolder?: SharedFolder,
	): T | null;
	visitFile(
		file: TFile,
		item: FileItem,
		storage?: T,
		sharedFolder?: SharedFolder,
	): T | null;
}

interface Destroyable {
	destroy(): void;
}

class BaseVisitor<T extends Destroyable> implements FileSystemVisitor<T> {
	visitFolder(
		folder: TFolder,
		item: FolderItem,
		storage?: T,
		sharedFolder?: SharedFolder,
	): T | null {
		// do nothing
		return null;
	}

	visitFile(
		file: TFile,
		item: FileItem,
		storage: T,
		sharedFolder: SharedFolder,
	): T | null {
		// do nothing
		return null;
	}
}

class FolderBar implements Destroyable {
	el: HTMLElement;
	sharedFolder: SharedFolder;
	siblingWatcher: SiblingWatcher;

	constructor(el: HTMLElement, sharedFolder: SharedFolder) {
		this.el = el;
		this.sharedFolder = sharedFolder;
		this.siblingWatcher = new SiblingWatcher(this.el, (el) => {
			this.add();
		});
		this.add();
	}

	add() {
		(this.el.nextSibling as HTMLElement)?.addClass("system3-live");
	}

	remove() {
		(this.el.nextSibling as HTMLElement)?.removeClass("system3-live");
	}

	destroy() {
		this.siblingWatcher.destroy();
		this.remove();
	}
}

class FolderBarVisitor extends BaseVisitor<FolderBar> {
	visitFolder(
		folder: TFolder,
		item: FolderItem,
		storage: FolderBar,
		sharedFolder?: SharedFolder,
	): FolderBar | null {
		if (sharedFolder && sharedFolder.path === folder.path) {
			return storage || new FolderBar(item.selfEl, sharedFolder);
		}
		if (storage) {
			storage.destroy();
		}
		return null;
	}
}

type Unsubscribe = () => void;

class PillDecoration {
	el: HTMLElement;
	sharedFolder: SharedFolder;
	pill: Pill;
	unsubscribe: Unsubscribe;

	constructor(el: HTMLElement, sharedFolder: SharedFolder) {
		this.el = el;
		this.sharedFolder = sharedFolder;
		this.el.addClass("system3-pill");

		this.pill = new Pill({
			target: this.el,
			props: {
				status: this.sharedFolder.state.status,
				remote: this.sharedFolder.remote,
			},
		});
		this.unsubscribe = this.sharedFolder.subscribe(
			this.el,
			(state: ConnectionState) => {
				this.pill.$set({
					status: state.status,
					remote: this.sharedFolder.remote,
				});
			},
		);
	}

	destroy() {
		this.pill.$destroy();
		this.unsubscribe();
		this.el.removeClass("system3-pill");
	}
}

class FolderPillVisitor extends BaseVisitor<PillDecoration> {
	visitFolder(
		folder: TFolder,
		item: FolderItem,
		storage?: PillDecoration,
		sharedFolder?: SharedFolder,
	): PillDecoration | null {
		if (sharedFolder && sharedFolder.path === folder.path) {
			return storage || new PillDecoration(item.selfEl, sharedFolder);
		}
		if (storage) {
			storage.destroy();
		}
		return null;
	}
}

class FilePillDecoration {
	pill: TextPill;
	unsubscribe?: () => void;

	constructor(
		private el: HTMLElement,
		private doc: IFile,
	) {
		this.el = el;
		this.el.querySelectorAll(".system3-filepill").forEach((el) => {
			el.remove();
		});
		if (doc instanceof Document) {
			this.pill = new TextPill({
				target: this.el,
				props: {
					text: `${doc.guid.slice(0, 3)} ${doc.dbsize}`,
				},
			});
			const onUpdate = () => {
				this.pill.$set({
					text: `${doc.guid.slice(0, 3)} ${doc.dbsize} ${doc._hasKnownPeers ? "!" : ""}`,
				});
			};
			doc.ydoc.on("update", onUpdate);
			doc.hasKnownPeers().then((hasKnownPeers) => {
				onUpdate();
			});
			this.unsubscribe = () => {
				doc.ydoc.off("update", onUpdate);
			};
		} else {
			this.pill = new TextPill({
				target: this.el,
				props: {
					text: `${doc.guid.slice(0, 4)}`,
				},
			});
		}
	}

	destroy() {
		this.pill.$destroy();
		this.unsubscribe?.();
		this.el.querySelectorAll(".system3-filepill").forEach((el) => {
			el.remove();
		});
	}
}

class FilePillVisitor extends BaseVisitor<FilePillDecoration> {
	visitFile(
		file: TFile,
		item: FileItem,
		storage?: FilePillDecoration,
		sharedFolder?: SharedFolder,
	): FilePillDecoration | null {
		if (sharedFolder) {
			const vpath = sharedFolder.getVirtualPath(file.path);
			const meta = sharedFolder.syncStore.get(vpath);
			if (!meta) return null;
			const doc = sharedFolder.docs.get(meta.id);
			if (!doc) return null;
			return storage || new FilePillDecoration(item.selfEl, doc);
		}
		if (storage) {
			storage.destroy();
		}
		return null;
	}
}

class DocumentStatus implements Destroyable {
	el: HTMLElement;
	document?: Document;

	constructor(el: HTMLElement, document: Document, doc: TFile) {
		this.el = el;
		this.document = document;
		this.document.subscribe(el, (status) => {
			this.docStatus(status);
		});
		this.docStatus(this.document.state);
	}

	docStatus(status?: ConnectionState) {
		if (status?.status === "connected") {
			this.el.removeClass("system3-connecting");
			this.el.addClass("system3-connected");
			this.el.addClass("system3-live");
		} else if (status?.status === "connecting") {
			this.el.removeClass("system3-connected");
			this.el.addClass("system3-connecting");
			this.el.addClass("system3-live");
		} else if (status?.status === "disconnected") {
			this.el.addClass("system3-live");
			this.el.removeClass("system3-connected");
			this.el.removeClass("system3-connecting");
		} else {
			this.el.removeClass("system3-connected");
			this.el.removeClass("system3-connecting");
			this.el.removeClass("system3-live");
		}
	}

	destroy() {
		this.document?.unsubscribe(this.el);
		this.docStatus();
	}
}

class FileStatusVisitor extends BaseVisitor<DocumentStatus> {
	visitFile(
		file: TFile,
		item: FileItem,
		storage?: DocumentStatus,
		sharedFolder?: SharedFolder,
	): DocumentStatus | null {
		if (sharedFolder) {
			try {
				const meta = sharedFolder.syncStore.get(
					sharedFolder.getVirtualPath(file.path),
				);
				if (!meta) return null;
				const document = sharedFolder.docs.get(meta.id);
				if (!(document instanceof Document)) return null;
				if (!document) return null;
				return storage || new DocumentStatus(item.el, document, file);
			} catch (e) {
				// document doesn't exist yet...
				return null;
			}
		}
		if (storage) {
			storage.destroy();
		}
		return null;
	}
}

class FileExplorerWalker {
	fileExplorer: WorkspaceLeaf;
	sharedFolders: SharedFolders;
	visitors: FileSystemVisitor<Destroyable>[];
	storage: Map<FileSystemVisitor<Destroyable>, Map<TreeNode, Destroyable>>;

	constructor(
		fileExplorer: WorkspaceLeaf,
		sharedFolders: SharedFolders,
		visitors: FileSystemVisitor<Destroyable>[],
	) {
		this.fileExplorer = fileExplorer;
		this.sharedFolders = sharedFolders;
		this.visitors = visitors;

		this.storage = new Map<
			FileSystemVisitor<Destroyable>,
			Map<TreeNode, Destroyable>
		>();
		for (const visitor of this.visitors) {
			this.storage.set(visitor, new Map<TreeNode, Destroyable>());
		}
	}

	private _getFileExplorerItem(path: string) {
		// XXX this is a private API
		try {
			//@ts-expect-error this is a private API
			return this.fileExplorer.view.fileItems[path];
		} catch (e) {
			return null;
		}
	}
	private getFileExplorerItem<T>(fileExplorer: WorkspaceLeaf, file: string): T;

	private getFileExplorerItem<T>(
		fileExplorer: WorkspaceLeaf,
		file: TAbstractFile,
	): T;

	// XXX this is a private API
	private getFileExplorerItem<T>(
		fileExplorer: WorkspaceLeaf,
		fileOrFolder: TAbstractFile | string,
	) {
		if (typeof fileOrFolder === "string") {
			return this._getFileExplorerItem(fileOrFolder) as T;
		}
		return this._getFileExplorerItem(fileOrFolder.path) as T;
	}

	walk(folder: TFolder, _sharedFolder?: SharedFolder) {
		if (this.fileExplorer.view.getViewType() !== "file-explorer") {
			return;
		}
		const sharedFolder =
			this.sharedFolders.find(
				(sharedFolder) => sharedFolder.path === folder.path,
			) || _sharedFolder;

		const folderItem = this.getFileExplorerItem<FolderItem>(
			this.fileExplorer,
			folder,
		);
		if (folderItem) {
			this.storage.forEach((store, visitor) => {
				const stored = store.get(folderItem);
				const update = visitor.visitFolder(
					folder,
					folderItem,
					stored,
					sharedFolder,
				);
				if (stored && !update) {
					store.delete(folderItem);
				} else if (update) {
					store.set(folderItem, update);
				}
			});
		}
		folder.children.forEach((child) => {
			if (child instanceof TFolder) {
				this.walk(child, sharedFolder);
			} else if (child instanceof TFile) {
				const fileItem = this.getFileExplorerItem<FileItem>(
					this.fileExplorer,
					child,
				);
				this.storage.forEach((store, visitor) => {
					const stored = store.get(fileItem);
					const update = visitor.visitFile(
						child,
						fileItem,
						stored,
						sharedFolder,
					);
					if (stored && !update) {
						store.delete(fileItem);
					} else if (update) {
						store.set(fileItem, update);
					}
				});
			}
		});
	}

	destory() {
		this.storage.forEach((store) => {
			store.forEach((item) => {
				item.destroy();
			});
		});
	}
}

export class FolderNavigationDecorations {
	vault: Vault;
	workspace: Workspace;
	sharedFolders: SharedFolders;
	offFolderListener: () => void;
	offDocumentListeners: Map<SharedFolder, () => void>;
	offLayoutChange: () => void;
	treeState: Map<WorkspaceLeaf, FileExplorerWalker>;

	constructor(
		vault: Vault,
		workspace: Workspace,
		sharedFolders: SharedFolders,
	) {
		this.vault = vault;
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;
		this.treeState = new Map<WorkspaceLeaf, FileExplorerWalker>();
		this.workspace.onLayoutReady(() => this.refresh());
		this.offDocumentListeners = new Map();
		this.offFolderListener = this.sharedFolders.subscribe(() => {
			this.sharedFolders.forEach((folder) => {
				withAnyOf([flag.enableDocumentStatus, flag.enableDebugFileTag], () => {
					const docsetListener = this.offDocumentListeners.get(folder);
					if (!docsetListener) {
						this.offDocumentListeners.set(
							folder,
							folder.docset.on(() => {
								// XXX a full refresh is only needed when a document is moved
								// outside of a shared folder.
								this.refresh();
							}),
						);
					}
				});
			});
			this.refresh();
		});
		this.offLayoutChange = (() => {
			const ref = this.workspace.on("layout-change", () => this.quickRefresh());
			return () => {
				this.workspace.offref(ref);
			};
		})();
	}

	makeVisitors(): FileSystemVisitor<Destroyable>[] {
		const visitors = [];
		visitors.push(new FolderBarVisitor());
		visitors.push(new FolderPillVisitor());
		withFlag(flag.enableDocumentStatus, () => {
			visitors.push(new FileStatusVisitor());
		});
		withFlag(flag.enableDebugFileTag, () => {
			visitors.push(new FilePillVisitor());
		});
		return visitors;
	}

	getFileExplorers(): WorkspaceLeaf[] {
		// IMPORTANT: We manually iterate because a popular plugin make.md monkeypatches
		// getLeavesOfType to return their custom folder explorer.
		const fileExplorers: WorkspaceLeaf[] = [];
		this.workspace.iterateAllLeaves((leaf) => {
			const viewType = leaf.view.getViewType();
			if (viewType === "file-explorer") {
				if (!fileExplorers.includes(leaf)) {
					fileExplorers.push(leaf);
				}
			}
		});
		return fileExplorers;
	}

	quickRefresh() {
		const fileExplorers = this.getFileExplorers();
		const sharedFolders = this.sharedFolders.map((folder) => folder.path);
		for (const fileExplorer of fileExplorers) {
			const walker =
				this.treeState.get(fileExplorer) ||
				new FileExplorerWalker(
					fileExplorer,
					this.sharedFolders,
					this.makeVisitors(),
				);
			this.treeState.set(fileExplorer, walker);
			for (const sharedFolderPath of sharedFolders) {
				const sharedFolder = this.vault.getAbstractFileByPath(sharedFolderPath);
				if (sharedFolder instanceof TFolder) {
					walker.walk(sharedFolder);
				}
			}
		}
	}

	refresh() {
		const fileExplorers = this.getFileExplorers();
		for (const fileExplorer of fileExplorers) {
			const walker =
				this.treeState.get(fileExplorer) ||
				new FileExplorerWalker(
					fileExplorer,
					this.sharedFolders,
					this.makeVisitors(),
				);
			this.treeState.set(fileExplorer, walker);
			const root = this.vault.getAbstractFileByPath("/");
			if (root instanceof TFolder) {
				walker.walk(root);
			}
		}
	}

	destroy() {
		this.offFolderListener();
		this.offDocumentListeners.forEach((off) => off());
		this.offDocumentListeners.clear();
		this.treeState.forEach((walker) => {
			walker.destory();
		});
		this.treeState.clear();
		this.offLayoutChange();

		this.vault = null as any;
		this.workspace = null as any;
		this.sharedFolders = null as any;
	}
}
