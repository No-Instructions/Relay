import { Workspace, WorkspaceLeaf } from "obsidian";
import ResourceMeterContent from "../components/ResourceMeterContent.svelte";
import { flags } from "../flagManager";
import type { SharedFolders } from "../SharedFolder";

/**
 * Mounts a ResourceMeterContent Svelte component into the file explorer sidebar,
 * inside `.workspace-drawer-vault-actions` (next to the help and settings icons).
 *
 * Gated behind the `enableResourceMeter` feature flag.
 * Reads wake queue stats from SharedFolders' MergeManagers on each layout change.
 */
export class ResourceMeterMount {
	private component: ResourceMeterContent | null = null;
	private containerEl: HTMLElement | null = null;
	private workspace: Workspace;
	private sharedFolders: SharedFolders;
	private offLayoutChange: (() => void) | null = null;
	private refreshInterval: ReturnType<typeof setInterval> | null = null;
	private layoutReady = false;

	constructor(workspace: Workspace, sharedFolders: SharedFolders) {
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;

		this.workspace.onLayoutReady(() => {
			this.layoutReady = true;
			this.sync();
		});

		this.offLayoutChange = (() => {
			const ref = this.workspace.on("layout-change", () => this.sync());
			return () => {
				this.workspace.offref(ref);
			};
		})();

		// Periodic refresh so the meter updates when hibernation frees slots
		this.refreshInterval = setInterval(() => this.sync(), 10_000);
	}

	private sync(): void {
		if (!this.layoutReady) return;

		const enabled = flags().enableResourceMeter;
		if (enabled && !this.component) {
			this.mount();
		} else if (!enabled && this.component) {
			this.unmount();
		}

		if (this.component) {
			this.refreshStats();
		}
	}

	private refreshStats(): void {
		const folders: { name: string; used: number; pending: number; total: number }[] = [];
		this.sharedFolders.forEach((folder) => {
			const stats = folder.mergeManager.getWakeQueueStats();
			folders.push({ name: folder.name, ...stats });
		});
		this.component?.$set({ folders });
	}

	private mount(): void {
		const target = this.findVaultActions();
		if (!target) return;

		this.containerEl = document.createElement("span");
		this.containerEl.classList.add("clickable-icon", "system3-resource-meter");
		target.insertBefore(this.containerEl, target.firstChild);

		this.component = new ResourceMeterContent({
			target: this.containerEl,
			props: {
				label: "Wake Queue",
				folders: [],
			},
		});
	}

	private unmount(): void {
		this.component?.$destroy();
		this.component = null;
		this.containerEl?.remove();
		this.containerEl = null;
	}

	private findVaultActions(): HTMLElement | null {
		let found: HTMLElement | null = null;
		this.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
			if (found) return;
			if (leaf.view.getViewType() !== "file-explorer") return;
			const sidebar = leaf.view.containerEl.closest(".workspace-split");
			if (!sidebar) return;
			const el = sidebar.querySelector<HTMLElement>(
				".workspace-drawer-vault-actions",
			);
			if (el) found = el;
		});
		return found;
	}

	destroy(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
		this.offLayoutChange?.();
		this.offLayoutChange = null;
		this.unmount();
		this.workspace = null as any;
		this.sharedFolders = null as any;
	}
}
