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
import type { SharedFolder, SharedFolders } from "../SharedFolder";
import type { TimeProvider } from "../TimeProvider";
import { getSyncStatusActivityStore } from "./SyncStatusActivity";

export const VIEW_TYPE_SYNC_STATUS = "system3-sync-status";

interface SyncStatusViewBinding {
	sharedFolder: SharedFolder;
	timeProvider: TimeProvider;
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

	setBinding(binding: SyncStatusViewBinding): void {
		this.binding = binding;
		this.renderContents();
	}

	bindToActiveFile(): void {
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
				this.rebindToFile(file ?? null);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf === this.leaf) {
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
			this.bindToActiveFile();
		});

		this.bindToActiveFile();
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
		headerEl.style.setProperty("position", "relative");
		headerEl.style.setProperty("cursor", "pointer");
		headerEl.style.setProperty("margin-inline-start", "0px", "important");
		headerEl.style.setProperty("padding-inline-start", "24px", "important");
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

		const titleEl = headerEl.createDiv({
			cls: "tree-item-inner nav-folder-title-content",
			text: this.folderOptionLabel(folder),
		});
		titleEl.style.setProperty("flex", "1 1 auto");
		titleEl.style.setProperty("min-width", "0");
		titleEl.style.setProperty("overflow", "hidden");
		titleEl.style.setProperty("text-overflow", "ellipsis");
		titleEl.style.setProperty("white-space", "nowrap");

		this.headerPill = new Pill({
			target: headerEl,
			props: {
				status: folder.state.status,
				relayId: folder.relayId,
				remote: folder.remote,
				localOnly: folder.localOnly,
				enableDraftMode: flags().enableDraftMode,
				progress: 0,
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
			folder.backgroundSync.subscribeToGroupProgress(folder, () => {
				const effective = folder.backgroundSync.getFolderPillProgress(folder);
				if (!effective) return;
				this.headerPill?.$set({
					progress: effective.percent,
					syncStatus: effective.status,
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
					.setIcon("folder")
					.setChecked(folder === this.binding?.sharedFolder)
					.onClick(() => {
						if (folder === this.binding?.sharedFolder) return;
						this.setBinding({
							sharedFolder: folder,
							timeProvider: this.context.timeProvider,
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
		requestAnimationFrame(() => {
			const menus = anchorEl.ownerDocument.querySelectorAll<HTMLElement>(".menu");
			const menuEl = menus[menus.length - 1];
			if (!menuEl) return;
			menuEl.style.setProperty("left", `${rect.left}px`, "important");
			menuEl.style.setProperty("right", "auto", "important");
			menuEl.style.setProperty("width", `${rect.width}px`, "important");
			menuEl.style.setProperty("min-width", `${rect.width}px`, "important");
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
			view.setBinding({ sharedFolder, timeProvider });
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
		view.setBinding({ sharedFolder, timeProvider });
	} else {
		view.bindToActiveFile();
	}
	workspace.revealLeaf(leaf);
	return view;
}
