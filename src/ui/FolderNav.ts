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
import UploadPill from "src/components/UploadPill.svelte";
import { withAnyOf, withFlag } from "src/flagManager";
import { flag } from "src/flags";
import type { BackgroundSync, QueueItem } from "src/BackgroundSync";
import type { Unsubscriber } from "src/observable/Observable";
import type { ObservableSet } from "src/observable/ObservableSet";
import { SyncFile, isSyncFile } from "src/SyncFile";
import { Canvas } from "src/Canvas";
import { curryLog } from "src/debug";

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
		this.sharedFolder = sharedFolder;

		// clean up failed destroys
		const stalePills = el.querySelectorAll(".system3-folder-icons");
		if (stalePills.length > 1) {
			stalePills?.forEach((pill) => {
				pill.remove();
			});
		}

		this.el = el;
		this.el.addClass("system3-pill");

		this.pill = new Pill({
			target: this.el,
			props: {
				status: this.sharedFolder.state.status,
				relayId: this.sharedFolder.relayId,
				remote: this.sharedFolder.remote,
				progress: 0,
				syncStatus: "pending",
			},
		});

		const unsubs: Unsubscribe[] = [];
		unsubs.push(
			this.sharedFolder.subscribe(this.el, (state: ConnectionState) => {
				this.pill.$set({
					status: state.status,
					relayId: this.sharedFolder.relayId,
					remote: this.sharedFolder.remote,
				});
			}),
		);

		unsubs.push(
			this.sharedFolder.backgroundSync.subscribeToGroupProgress(
				this.sharedFolder,
				(progress) => {
					if (progress) {
						this.pill.$set({
							progress: progress.percent,
							syncStatus: progress.status,
						});
					}
				},
			),
		);
		this.unsubscribe = () => unsubs.forEach((u) => u());
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

class QueueWatcher implements Destroyable {
	private unsubscribers: Unsubscriber[] = [];
	private titleEl: HTMLElement;

	constructor(
		private el: HTMLElement,
		private path: string,
		private activeSync: ObservableSet<QueueItem>,
		private activeDownloads: ObservableSet<QueueItem>,
	) {
		this.titleEl = el.querySelector(".nav-file-title") || el;

		this.unsubscribers.push(
			this.activeSync.subscribe(() => this.checkStatus()),
			this.activeDownloads.subscribe(() => this.checkStatus()),
		);
		this.checkStatus();
	}

	private checkStatus() {
		const isSyncing = this.activeSync.some((item) => item.path === this.path);
		const isDownloading = this.activeDownloads.some(
			(item) => item.path === this.path,
		);

		if (isSyncing) {
			this.titleEl.addClass("system3-syncing");
		} else {
			this.titleEl.removeClass("system3-syncing");
		}

		if (isDownloading) {
			this.titleEl.addClass("system3-downloading");
		} else {
			this.titleEl.removeClass("system3-downloading");
		}
	}

	destroy() {
		this.titleEl.removeClass("system3-uploading");
		this.titleEl.removeClass("system3-downloading");
		this.unsubscribers.forEach((unsub) => unsub());
	}
}

class QueueWatcherVisitor extends BaseVisitor<QueueWatcher> {
	constructor(
		private activeSync: ObservableSet<QueueItem>,
		private activeDownloads: ObservableSet<QueueItem>,
	) {
		super();
	}

	visitFile(
		file: TFile,
		item: FileItem,
		storage?: QueueWatcher,
		sharedFolder?: SharedFolder,
	): QueueWatcher | null {
		if (
			sharedFolder &&
			sharedFolder.ready &&
			sharedFolder.checkPath(file.path) &&
			Document.checkExtension(file.path)
		) {
			return (
				storage ||
				new QueueWatcher(
					item.el,
					file.path,
					this.activeSync,
					this.activeDownloads,
				)
			);
		}
		if (storage) {
			storage.destroy();
		}
		return null;
	}
}

class FilePillDecoration {
	pill?: TextPill;
	unsubscribes: Unsubscriber[] = [];

	constructor(
		private el: HTMLElement,
		public file: SyncFile,
	) {
		this.el.querySelectorAll(".system3-uploadpill").forEach((el) => {
			el.remove();
		});

		this.unsubscribes.push(
			this.file.subscribe(() => {
				this.setText();
			}),
		);
	}

	setText() {
		if (!this.file) {
			return;
		}
		if (this.file.inMeta) {
			this.pill?.$destroy();
			return;
		}
		if (!this.pill) {
			this.pill = new UploadPill({
				target: this.el,
				props: {
					text: this.file.tag,
				},
			});
		} else {
			this.pill.$set({
				text: this.file.tag,
			});
		}
	}

	destroy() {
		this.unsubscribes.forEach((off) => off());
		this.el.querySelectorAll(".system3-uploadpill").forEach((el) => {
			el.remove();
		});
		this.pill?.$destroy();
		this.file = null as any;
	}
}

class FilePillVisitor extends BaseVisitor<FilePillDecoration> {
	visitFile(
		tfile: TFile,
		item: FileItem,
		storage?: FilePillDecoration,
		sharedFolder?: SharedFolder,
	): FilePillDecoration | null {
		if (
			sharedFolder &&
			!Document.checkExtension(tfile.path) &&
			!Canvas.checkExtension(tfile.path) &&
			sharedFolder.isSyncableTFile(tfile)
		) {
			if (sharedFolder.ready && sharedFolder.connected) {
				try {
					const file = sharedFolder.proxy.viewSyncFile(tfile.path);
					if (file && isSyncFile(file)) {
						if (storage && storage.file === file) {
							return storage;
						}
						return new FilePillDecoration(item.selfEl, file);
					}
				} catch (e) {
					const error = curryLog("FilePillVisitor.visitFile", "error");
					error(e);
				}
			}
		}
		if (storage) {
			storage.destroy();
		}
		return null;
	}
}

class NotSyncedPillDecoration {
	pill: TextPill;
	unsubscribe?: () => void;

	constructor(private el: HTMLElement) {
		this.el.querySelectorAll(".system3-filepill").forEach((el) => {
			el.remove();
		});
		// TODO: Ensure the not-synced pill comes last
		this.pill = new TextPill({
			target: this.el,
			props: {
				text: "NOT SYNCED",
				label: "Syncing this file type is disabled",
			},
		});
	}

	destroy() {
		this.pill.$destroy();
		this.el.querySelectorAll(".system3-filepill").forEach((el) => {
			el.remove();
		});
	}
}

class NotSyncedPillVisitor extends BaseVisitor<NotSyncedPillDecoration> {
	visitFile(
		file: TFile,
		item: FileItem,
		storage?: NotSyncedPillDecoration,
		sharedFolder?: SharedFolder,
	): NotSyncedPillDecoration | null {
		if (
			sharedFolder &&
			sharedFolder.checkPath(file.path) &&
			!sharedFolder.isSyncableTFile(file)
		) {
			return storage || new NotSyncedPillDecoration(item.selfEl);
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
				const vpath = sharedFolder.getVirtualPath(file.path);
				const guid = sharedFolder.syncStore.get(vpath);
				if (!guid) return null;
				const document = sharedFolder.files.get(guid);
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
				if (!fileItem) {
					// Android bug?
					return;
				}
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

	destroy() {
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
	backgroundSync: BackgroundSync;
	offFolderListener: () => void;
	offDocumentListeners: Map<SharedFolder, () => void>;
	offLayoutChange: () => void;
	treeState: Map<WorkspaceLeaf, FileExplorerWalker>;
	layoutReady: boolean = false;
	unsubscribes: Unsubscribe[];

	constructor(
		vault: Vault,
		workspace: Workspace,
		sharedFolders: SharedFolders,
		backgroundSync: BackgroundSync,
	) {
		this.vault = vault;
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;
		this.backgroundSync = backgroundSync;
		this.treeState = new Map<WorkspaceLeaf, FileExplorerWalker>();
		this.workspace.onLayoutReady(() => {
			this.layoutReady = true;
			this.refresh();
		});
		this.unsubscribes = [];

		this.unsubscribes.push(
			backgroundSync.activeSync.subscribe(() => this.quickRefresh()),
			backgroundSync.activeDownloads.subscribe(() => this.quickRefresh()),
			backgroundSync.syncGroups.subscribe(() => this.quickRefresh()),
		);

		this.offDocumentListeners = new Map();
		this.offFolderListener = this.sharedFolders.subscribe(() => {
			this.sharedFolders.forEach((folder) => {
				withAnyOf([flag.enableDocumentStatus], () => {
					const docsetListener = this.offDocumentListeners.get(folder);
					if (!docsetListener) {
						this.offDocumentListeners.set(
							folder,
							folder.fset.on(() => {
								// XXX a full refresh is only needed when a document is moved
								// outside of a shared folder.
								this.refresh();
							}),
						);
					}
				});
				folder.whenReady().then(() => {
					this.refresh();
				});
				this.unsubscribes.push(
					folder.syncSettingsManager.subscribe((settings) => {
						this.quickRefresh();
					}),
				);
				this.unsubscribes.push(
					folder.subscribe(this, () => {
						this.quickRefresh();
					}),
				);
				this.unsubscribes.push(
					folder.syncStore.subscribe((syncStore) => {
						this.quickRefresh();
					}),
				);
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
			visitors.push(
				new QueueWatcherVisitor(
					this.backgroundSync.activeSync,
					this.backgroundSync.activeDownloads,
				),
			);
		});
		visitors.push(new FilePillVisitor());
		visitors.push(new NotSyncedPillVisitor());
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
		if (!this.layoutReady) return;
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
		if (!this.layoutReady) return;
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
		this.offFolderListener?.();
		this.offDocumentListeners.forEach((off) => off());
		this.offDocumentListeners.clear();
		this.unsubscribes.forEach((unsub) => unsub());
		this.unsubscribes.length = 0;
		this.treeState.forEach((walker) => {
			walker.destroy();
		});
		this.treeState.clear();
		this.offLayoutChange();

		this.vault = null as any;
		this.workspace = null as any;
		this.sharedFolders = null as any;
		this.backgroundSync = null as any;
		this.offFolderListener = null as any;
	}
}
