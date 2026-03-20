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
		let used = 0;
		let pending = 0;
		let total = 0;
		this.sharedFolders.forEach((folder) => {
			const stats = folder.mergeManager.getWakeQueueStats();
			used += stats.used;
			pending += stats.pending;
			total += stats.total;
		});
		this.component?.$set({ used, pending, total });
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
				itemLabel: "Slots",
				used: 0,
				pending: 0,
				total: 0,
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
		this.offLayoutChange?.();
		this.offLayoutChange = null;
		this.unmount();
		this.workspace = null as any;
		this.sharedFolders = null as any;
	}
}
