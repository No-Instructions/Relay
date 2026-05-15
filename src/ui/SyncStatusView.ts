import {
	ItemView,
	Menu,
	TFile,
	WorkspaceLeaf,
	setIcon,
	type Workspace,
} from "obsidian";
import SyncStatusModalContent from "../components/SyncStatusModalContent.svelte";
import Pill from "../components/Pill.svelte";
import { flags } from "../flagManager";
import type { FolderSyncVisibleState } from "../BackgroundSyncProgress";
import type { SharedFolder, SharedFolders } from "../SharedFolder";
import type { TimeProvider } from "../TimeProvider";
import { getSyncStatusActivityStore } from "./SyncStatusActivity";

export const VIEW_TYPE_SYNC_STATUS = "system3-sync-status";

interface SyncStatusViewBinding {
	sharedFolder: SharedFolder;
	timeProvider: TimeProvider;
}

interface SyncStatusViewBindingOptions {
	followActiveFile?: boolean;
}

export interface SyncStatusViewContext {
	sharedFolders: SharedFolders;
	timeProvider: TimeProvider;
}

export class SyncStatusView extends ItemView {
	private component?: SyncStatusModalContent;
	private headerPill?: Pill;
	private binding: SyncStatusViewBinding | null = null;
	private headerUnsubscribers: (() => void)[] = [];
	private followActiveFile = true;

	constructor(
		leaf: WorkspaceLeaf,
		private context: SyncStatusViewContext,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SYNC_STATUS;
	}

	getDisplayText(): string {
		return "Sync Status";
	}

	getIcon(): string {
		return "satellite";
	}

	setBinding(
		binding: SyncStatusViewBinding,
		options: SyncStatusViewBindingOptions = {},
	): void {
		if (options.followActiveFile !== undefined) {
			this.followActiveFile = options.followActiveFile;
		}
		this.binding = binding;
		this.renderContents();
	}

	bindToActiveFile(): void {
		this.followActiveFile = true;
		this.rebindToFile(this.app.workspace.getActiveFile());
		this.ensureBinding();
	}

	async onOpen(): Promise<void> {
		const keeper = cleanupSyncStatusViews(this.app.workspace);
		if (keeper && keeper !== this.leaf) return;

		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("system3-sync-status-panel");

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.followActiveFile) return;
				this.rebindToFile(file ?? null);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf === this.leaf && this.followActiveFile) {
					this.bindToActiveFile();
				}
			}),
		);
		this.register(
			this.context.sharedFolders.subscribe(() => {
				this.handleSharedFoldersChanged();
			}),
		);

		// Initial bind runs once the workspace layout is ready so
		// `getActiveFile()` returns the real focused file rather than null
		// during the plugin-load race.
		this.app.workspace.onLayoutReady(() => {
			if (!this.followActiveFile) return;
			this.bindToActiveFile();
		});

		if (this.followActiveFile) {
			this.bindToActiveFile();
		}
		this.renderContents();
	}

	async onClose(): Promise<void> {
		this.component?.$destroy();
		this.component = undefined;
		this.destroyFolderHeader();
	}

	private rebindToFile(file: TFile | null): void {
		if (!file) return;
		const folder = this.context.sharedFolders.lookup(file.path);
		if (!folder) return;
		if (this.binding?.sharedFolder === folder) return;
		this.setBinding({
			sharedFolder: folder,
			timeProvider: this.context.timeProvider,
		});
	}

	private ensureBinding(): void {
		if (this.binding && this.context.sharedFolders.has(this.binding.sharedFolder)) return;
		const folder = this.sortedSharedFolders()[0];
		if (folder) {
			this.setBinding({
				sharedFolder: folder,
				timeProvider: this.context.timeProvider,
			});
			return;
		}
		this.binding = null;
	}

	private handleSharedFoldersChanged(): void {
		if (!this.containerEl) return;
		if (!this.binding || !this.context.sharedFolders.has(this.binding.sharedFolder)) {
			this.ensureBinding();
		}
		this.renderContents();
	}

	private sortedSharedFolders(): SharedFolder[] {
		return this.context.sharedFolders
			.items()
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	private folderOptionLabel(folder: SharedFolder): string {
		const folders = this.context.sharedFolders.items();
		const duplicateName = folders.some(
			(candidate) => candidate !== folder && candidate.name === folder.name,
		);
		return duplicateName ? folder.path : folder.name || folder.path;
	}

	private folderStatusIcon(folder: SharedFolder): string {
		return iconForFolderSyncState(
			folder.backgroundSync.getFolderSyncSnapshot(folder).visibleState,
		);
	}

	private renderContents(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		if (!container) return;

		this.component?.$destroy();
		this.component = undefined;
		this.destroyFolderHeader();
		container.empty();

		if (!this.binding) {
			container.createEl("div", {
				cls: "system3-sync-status-empty",
				text: "No folder selected.",
			});
			return;
		}

		this.renderFolderHeader(container, this.binding);
		const contentEl = container.createDiv({
			cls: "system3-sync-status-content",
		});

		this.component = new SyncStatusModalContent({
			target: contentEl,
			props: {
				sharedFolder: this.binding.sharedFolder,
				app: this.app,
				timeProvider: this.binding.timeProvider,
				activityStore: getSyncStatusActivityStore(
					this.binding.sharedFolder,
					this.binding.timeProvider,
				),
			},
		});
	}

	private renderFolderHeader(
		container: HTMLElement,
		binding: SyncStatusViewBinding,
	): void {
		const folder = binding.sharedFolder;
		const headerEl = container.createDiv({
			cls: "tree-item-self nav-folder-title is-clickable mod-collapsible system3-pill has-focus system3-sync-status-folder",
		});
		headerEl.dataset.path = folder.path;
		headerEl.setAttr("draggable", "false");
		headerEl.setAttr("role", "button");
		headerEl.setAttr("tabindex", "0");
		headerEl.setAttr("aria-label", `Select sync status folder, currently ${folder.path}`);
		headerEl.addEventListener("click", () => {
			this.showFolderMenu(headerEl);
		});
		headerEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
			event.preventDefault();
			this.showFolderMenu(headerEl);
		});

		const collapseIcon = headerEl.createDiv({
			cls: "tree-item-icon collapse-icon",
		});
		setIcon(collapseIcon, "right-triangle");

		headerEl.createDiv({
			cls: "tree-item-inner nav-folder-title-content",
			text: this.folderOptionLabel(folder),
		});

		this.headerPill = new Pill({
			target: headerEl,
			props: {
				status: folder.state.status,
				relayId: folder.relayId,
				remote: folder.remote,
				localOnly: folder.localOnly,
				enableDraftMode: flags().enableDraftMode,
				progress: 0,
				showProgress: false,
				syncStatus: "pending",
			},
		});

		this.headerUnsubscribers.push(
			folder.subscribe(headerEl, (state) => {
				this.headerPill?.$set({
					status: state.status,
					relayId: folder.relayId,
					remote: folder.remote,
					localOnly: folder.localOnly,
					enableDraftMode: flags().enableDraftMode,
				});
			}),
		);

		this.headerUnsubscribers.push(
			folder.backgroundSync.subscribeToFolderSyncSnapshot(folder, (snapshot) => {
				this.headerPill?.$set({
					progress: snapshot.percent,
					showProgress: snapshot.showProgress,
					syncStatus: snapshot.progressStatus,
				});
			}),
		);
	}

	private destroyFolderHeader(): void {
		this.headerPill?.$destroy();
		this.headerPill = undefined;
		this.headerUnsubscribers.forEach((unsubscribe) => unsubscribe());
		this.headerUnsubscribers = [];
	}

	private showFolderMenu(anchorEl: HTMLElement): void {
		const menu = new Menu().setUseNativeMenu(false);
		for (const folder of this.sortedSharedFolders()) {
			menu.addItem((item) => {
				item
					.setTitle(this.folderOptionLabel(folder))
					.setIcon(this.folderStatusIcon(folder))
					.setChecked(folder === this.binding?.sharedFolder)
					.onClick(() => {
						if (folder === this.binding?.sharedFolder) return;
						this.setBinding({
							sharedFolder: folder,
							timeProvider: this.context.timeProvider,
						}, {
							followActiveFile: false,
						});
					});
			});
		}

		const rect = anchorEl.getBoundingClientRect();
		menu.showAtPosition({
			x: rect.left,
			y: rect.bottom,
			width: rect.width,
			left: true,
		}, anchorEl.ownerDocument);
		window.requestAnimationFrame(() => {
			const menus = anchorEl.ownerDocument.querySelectorAll<HTMLElement>(".menu");
			const menuEl = menus[menus.length - 1];
			if (!menuEl) return;
			menuEl.addClass("system3-sync-status-folder-menu");
			menuEl.setCssProps({
				"--system3-sync-status-menu-left": `${rect.left}px`,
				"--system3-sync-status-menu-width": `${rect.width}px`,
			});
		});
	}
}

/**
 * Remove stale or duplicate sync-status leaves and return the single current
 * leaf that should remain open.
 */
export function cleanupSyncStatusViews(workspace: Workspace): WorkspaceLeaf | null {
	const leaves = workspace.getLeavesOfType(VIEW_TYPE_SYNC_STATUS);
	let keeper: WorkspaceLeaf | null = null;

	for (const leaf of leaves) {
		if (!keeper && leaf.view instanceof SyncStatusView) {
			keeper = leaf;
			continue;
		}
		leaf.detach();
	}

	return keeper;
}

export function detachSyncStatusViews(workspace: Workspace): void {
	workspace
		.getLeavesOfType(VIEW_TYPE_SYNC_STATUS)
		.forEach((leaf) => leaf.detach());
}

/**
 * Open the sync status view in the right sidebar. If a view is already open,
 * reveals it (and rebinds to `sharedFolder` when supplied). Without an
 * explicit folder the view auto-follows the active editor.
 */
export async function openSyncStatusView(
	workspace: Workspace,
	sharedFolder?: SharedFolder,
	timeProvider?: TimeProvider,
): Promise<SyncStatusView | null> {
	const existing = cleanupSyncStatusViews(workspace);
	if (existing) {
		const leaf = existing;
		const view = leaf.view as SyncStatusView;
		if (sharedFolder && timeProvider) {
			view.setBinding({ sharedFolder, timeProvider }, { followActiveFile: false });
		} else {
			view.bindToActiveFile();
		}
		workspace.revealLeaf(leaf);
		return view;
	}

	const leaf = workspace.getRightLeaf(false);
	if (!leaf) return null;

	await leaf.setViewState({
		type: VIEW_TYPE_SYNC_STATUS,
		active: true,
	});

	const view = leaf.view as SyncStatusView;
	if (sharedFolder && timeProvider) {
		view.setBinding({ sharedFolder, timeProvider }, { followActiveFile: false });
	} else {
		view.bindToActiveFile();
	}
	workspace.revealLeaf(leaf);
	return view;
}

function iconForFolderSyncState(state: FolderSyncVisibleState): string {
	switch (state) {
		case "syncing":
			return "folder-sync";
		case "queued":
			return "folder-sync";
		case "paused":
			return "pause";
		case "sync-issue":
			return "alert-triangle";
		case "synced":
		default:
			return "folder-check";
	}
}
