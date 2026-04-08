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
import { flags, withAnyOf, withFlag } from "src/flagManager";
import { flag } from "src/flags";
import type { BackgroundSync, QueueItem } from "src/BackgroundSync";
import type { Unsubscriber } from "src/observable/Observable";
import type { ObservableSet } from "src/observable/ObservableSet";
import { SyncFile, isSyncFile } from "src/SyncFile";
import { Canvas } from "src/Canvas";
import { curryLog, metrics } from "src/debug";

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
				localOnly: this.sharedFolder.localOnly,
				enableDraftMode: flags().enableDraftMode,
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
					localOnly: this.sharedFolder.localOnly,
					enableDraftMode: flags().enableDraftMode,
				});
			}),
		);

		unsubs.push(
			this.sharedFolder.backgroundSync.subscribeToGroupProgress(
				this.sharedFolder,
				(progress) => {
					const effective = flags().enableNewSyncStatus
						? this.sharedFolder.backgroundSync.getUserVisibleProgress(this.sharedFolder)
						: progress;
					if (effective) {
						this.pill.$set({
							progress: effective.percent,
							syncStatus: effective.status,
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

		// Subscribe to HSM sync status for UI updates
		// Get mergeManager from the file's sharedFolder (per-folder instance)
		const mergeManager = this.file.sharedFolder?.mergeManager;
		if (mergeManager) {
			this.unsubscribes.push(
				mergeManager.syncStatus.subscribe(() => {
					this.setTextFromHSM();
				})
			);
		} else {
			this.unsubscribes.push(
				this.file.subscribe(() => {
					this.setText();
				}),
			);
		}
	}

	private setTextFromHSM() {
		const mergeManager = this.file.sharedFolder?.mergeManager;
		const status = mergeManager?.syncStatus.get(this.file.guid);
		if (!status || status.status === 'synced') {
			this.pill?.$destroy();
			this.pill = undefined;
			return;
		}
		const tag = status.status; // 'pending' | 'conflict' | 'error'

		if (!this.pill) {
			this.pill = new UploadPill({
				target: this.el,
				props: { text: tag },
			});
		} else {
			this.pill.$set({ text: tag });
		}
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
	offLayoutChange: () => void;
	treeState: Map<WorkspaceLeaf, FileExplorerWalker>;
	layoutReady: boolean = false;

	/**
	 * Subscriptions to plugin-global observables (background sync
	 * stores, workspace layout). Attached once in the constructor and
	 * released once in destroy(). Never changes over the lifetime.
	 */
	private globalSubs: Unsubscribe[] = [];

	/**
	 * Root subscription on the SharedFolders ObservableSet itself —
	 * fires when a folder is added or removed from the plugin.
	 */
	private rootSub: Unsubscribe | null = null;

	/**
	 * Folders we've already attached the main subscription bundle to
	 * (syncSettings, folder, syncStore). Per-folder cleanup is
	 * registered via `folder.onDestroy(...)` so it fires automatically
	 * when the folder is destroyed — no per-subscriber teardown map
	 * here. The WeakSet is just dedup: the sharedFolders observer
	 * re-fires on every add/remove, and we only want to subscribe to
	 * each folder once over its lifetime.
	 */
	private subscribedFolders = new WeakSet<SharedFolder>();

	/**
	 * Separate dedup for the `fset.on` subscription, which is gated by
	 * `flag.enableDocumentStatus`. Tracked separately from
	 * `subscribedFolders` so that if the flag is flipped on mid-session
	 * the fset subscription is still attached on the next sharedFolders
	 * notification — matching the behavior of the original
	 * `offDocumentListeners` map.
	 */
	private subscribedFolderFsets = new WeakSet<SharedFolder>();

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

		this.globalSubs.push(
			backgroundSync.activeSync.subscribe(() => this.quickRefresh()),
			backgroundSync.activeDownloads.subscribe(() => this.quickRefresh()),
			backgroundSync.syncGroups.subscribe(() => this.quickRefresh()),
		);

		// Subscribe to the SharedFolders set. On every notification,
		// attach refresh-trigger subscriptions to any folders we
		// haven't seen yet. Cleanup is registered with each folder
		// via `folder.onDestroy(...)` — SharedFolder runs its own
		// unsubscribe queue at the top of destroy(), so external
		// subscriptions are released before any internal observable
		// is torn down. No per-folder diff loop needed here.
		//
		// Behavior contract (matches the pre-refactor structure):
		//   - whenReady().then(refresh) fires on every notification
		//   - fset.on has its own dedup gated by the feature flag so
		//     a mid-session flag flip can attach it late
		//   - the other three subs (syncSettings/folder/syncStore)
		//     are dedup'd per folder (the pre-refactor code leaked
		//     them on every notification — that was the teardown bug)
		this.rootSub = this.sharedFolders.subscribe(() => {
			this.sharedFolders.forEach((folder) => {
				withAnyOf([flag.enableDocumentStatus], () => {
					if (!this.subscribedFolderFsets.has(folder)) {
						this.subscribedFolderFsets.add(folder);
						folder.onDestroy(
							folder.fset.on(() => {
								// XXX a full refresh is only needed when a document
								// is moved outside of a shared folder.
								this.refresh();
							}),
						);
					}
				});

				// Refresh once the folder finishes its own load so we
				// paint decorations as soon as data is available. This
				// intentionally runs on every notification — matches
				// the pre-refactor behavior (the .then handler is
				// attached to the same cached promise each time, so
				// after resolution every repeat handler fires once).
				folder.whenReady().then(() => this.refresh());

				if (this.subscribedFolders.has(folder)) return;
				this.subscribedFolders.add(folder);

				folder.onDestroy(
					folder.syncSettingsManager.subscribe(() => this.quickRefresh()),
				);
				folder.onDestroy(folder.subscribe(this, () => this.quickRefresh()));
				folder.onDestroy(
					folder.syncStore.subscribe(() => this.quickRefresh()),
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
		const t0 = performance.now();
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
		metrics.observeFoldernavRefresh("quick", (performance.now() - t0) / 1000);
	}

	refresh() {
		if (!this.layoutReady) return;
		const t0 = performance.now();
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
		metrics.observeFoldernavRefresh("full", (performance.now() - t0) / 1000);
	}

	destroy() {
		// Release the root SharedFolders subscription first so no further
		// folder-add notifications can arrive while we're tearing down.
		this.rootSub?.();
		this.rootSub = null;

		// Release the plugin-global subscriptions. Per-folder subs are
		// not touched here — they are registered with each SharedFolder
		// via folder.onDestroy(), so they fire automatically when the
		// folder is destroyed (either at runtime delete or as part of
		// sharedFolders.destroy() during plugin unload).
		for (const unsub of this.globalSubs) {
			try { unsub(); } catch { /* observable torn down first */ }
		}
		this.globalSubs.length = 0;

		this.treeState.forEach((walker) => walker.destroy());
		this.treeState.clear();
		this.offLayoutChange();

		this.vault = null as any;
		this.workspace = null as any;
		this.sharedFolders = null as any;
		this.backgroundSync = null as any;
	}
}
