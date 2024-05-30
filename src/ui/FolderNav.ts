import {
	TAbstractFile,
	TFile,
	TFolder,
	Workspace,
	WorkspaceLeaf,
} from "obsidian";
import { SharedFolder, SharedFolders } from "../SharedFolder";
import { VaultFacade } from "src/obsidian-api/Vault";
import type { ConnectionState } from "src/HasProvider";
import type { Document } from "src/Document";
import Pill from "src/components/Pill.svelte";

class SiblingWatcher {
	mutationObserver: MutationObserver | null;
	el: HTMLElement;

	constructor(el: HTMLElement, onceSibling: (el: HTMLElement) => void) {
		this.el = el;

		const observer = new MutationObserver((mutationsList, observer) => {
			for (const mutation of mutationsList) {
				if (mutation.type === "childList") {
					if (el.nextSibling) {
						onceSibling(el);
						observer.disconnect();
					}
				}
			}
		});
		observer.observe(el.parentElement as HTMLElement, {
			childList: true,
			subtree: true,
		});
		this.mutationObserver = observer;
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
		sharedFolder?: SharedFolder
	): T | null;
	visitFile(
		file: TFile,
		item: FileItem,
		storage?: T,
		sharedFolder?: SharedFolder
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
		sharedFolder?: SharedFolder
	): T | null {
		// do nothing
		return null;
	}

	visitFile(
		file: TFile,
		item: FileItem,
		storage: T,
		sharedFolder: SharedFolder
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
		sharedFolder?: SharedFolder
	): FolderBar | null {
		if (sharedFolder) {
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
		this.pill = new Pill({
			target: this.el,
			props: {
				status: sharedFolder.state.status,
			},
		});
		this.unsubscribe = sharedFolder.subscribe(
			el,
			(state: ConnectionState) => {
				this.pill.$set({ status: state.status });
			}
		);
	}

	destroy() {
		this.pill.$destroy();
		this.unsubscribe();
	}
}

class FolderPillVisitor extends BaseVisitor<PillDecoration> {
	visitFolder(
		folder: TFolder,
		item: FolderItem,
		storage?: PillDecoration,
		sharedFolder?: SharedFolder
	): PillDecoration | null {
		if (sharedFolder) {
			return storage || new PillDecoration(item.selfEl, sharedFolder);
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
		sharedFolder?: SharedFolder
	): DocumentStatus | null {
		if (sharedFolder) {
			try {
				const document = sharedFolder.getFile(file.path, false);
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
		visitors: FileSystemVisitor<Destroyable>[]
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
		//@ts-expect-error this is a private API
		return this.fileExplorer.view.fileItems[path];
	}
	private getFileExplorerItem<T>(
		fileExplorer: WorkspaceLeaf,
		file: string
	): T;

	private getFileExplorerItem<T>(
		fileExplorer: WorkspaceLeaf,
		file: TAbstractFile
	): T;

	// XXX this is a private API
	private getFileExplorerItem<T>(
		fileExplorer: WorkspaceLeaf,
		fileOrFolder: TAbstractFile | string
	) {
		if (typeof fileOrFolder === "string") {
			return this._getFileExplorerItem(fileOrFolder) as T;
		}
		return this._getFileExplorerItem(fileOrFolder.path) as T;
	}

	walk(folder: TFolder) {
		const sharedFolder = this.sharedFolders.find(
			(sharedFolder) => sharedFolder.path === folder.path
		);
		const folderItem = this.getFileExplorerItem<FolderItem>(
			this.fileExplorer,
			folder
		);
		if (folderItem) {
			// XXX cache this
			this.storage.forEach((store, visitor) => {
				const stored = store.get(folderItem);
				const update = visitor.visitFolder(
					folder,
					folderItem,
					stored,
					sharedFolder
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
				this.walk(child);
			} else if (child instanceof TFile) {
				const fileItem = this.getFileExplorerItem<FileItem>(
					this.fileExplorer,
					child
				);
				this.storage.forEach((store, visitor) => {
					const stored = store.get(fileItem);
					const update = visitor.visitFile(
						child,
						fileItem,
						stored,
						sharedFolder
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
	vault: VaultFacade;
	workspace: Workspace;
	sharedFolders: SharedFolders;
	showDocumentStatus: boolean;
	offFolderListener: () => void;
	offDocumentListeners: Map<SharedFolder, () => void>;
	pills: Map<HTMLElement, Pill>;
	treeState: Map<WorkspaceLeaf, FileExplorerWalker>;

	constructor(
		vault: VaultFacade,
		workspace: Workspace,
		sharedFolders: SharedFolders,
		showDocumentStatus = false
	) {
		this.vault = vault;
		this.pills = new Map<HTMLElement, Pill>();
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;
		this.showDocumentStatus = showDocumentStatus;
		this.treeState = new Map<WorkspaceLeaf, FileExplorerWalker>();
		this.workspace.onLayoutReady(() => this.refresh());
		this.offDocumentListeners = new Map();
		const folderListener = () => {
			this.sharedFolders.forEach((folder) => {
				// XXX a full refresh is only needed when a document is moved outside of a shared folder.
				if (showDocumentStatus) {
					const documentListener = () => {
						this.refresh();
					};
					const docsetListener =
						this.offDocumentListeners.get(folder);
					if (!docsetListener) {
						folder.docset.on(documentListener);
						this.offDocumentListeners.set(folder, () => {
							folder.docset.off(documentListener);
						});
					}
				}
			});
			this.refresh();
		};
		this.sharedFolders.on(folderListener);
		this.offFolderListener = () => {
			this.sharedFolders.off(folderListener);
		};
		this.refresh();
	}

	register() {
		return this.workspace.on("layout-change", () => this.quickRefresh());
	}

	makeVisitors(): FileSystemVisitor<Destroyable>[] {
		const visitors = [];
		visitors.push(new FolderBarVisitor());
		visitors.push(new FolderPillVisitor());
		if (this.showDocumentStatus) {
			visitors.push(new FileStatusVisitor());
		}
		return visitors;
	}

	quickRefresh() {
		const fileExplorers = this.workspace.getLeavesOfType("file-explorer");
		const sharedFolders = this.sharedFolders.map((folder) => folder.path);
		for (const fileExplorer of fileExplorers) {
			const walker =
				this.treeState.get(fileExplorer) ||
				new FileExplorerWalker(
					fileExplorer,
					this.sharedFolders,
					this.makeVisitors()
				);
			this.treeState.set(fileExplorer, walker);
			for (const sharedFolderPath of sharedFolders) {
				const sharedFolder =
					this.vault.getAbstractFileByPath(sharedFolderPath);
				if (sharedFolder instanceof TFolder) {
					walker.walk(sharedFolder);
				}
			}
		}
	}

	refresh() {
		const fileExplorers = this.workspace.getLeavesOfType("file-explorer");
		for (const fileExplorer of fileExplorers) {
			const walker =
				this.treeState.get(fileExplorer) ||
				new FileExplorerWalker(
					fileExplorer,
					this.sharedFolders,
					this.makeVisitors()
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
		this.treeState.forEach((walker) => {
			walker.destory();
		});
		this.treeState.clear();
	}
}
