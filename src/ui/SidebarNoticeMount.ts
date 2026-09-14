import { Workspace } from "obsidian";
import type { MountedComponent } from "./svelteHost.svelte";

export class SidebarNoticeMount {
	private component: MountedComponent | null = null;
	private anchor: Comment | null = null;
	private offLayoutChange: (() => void) | null = null;
	private refreshInterval: number | null = null;
	private layoutReady = false;
	private destroyed = false;

	constructor(
		private workspace: Workspace,
		private slotClass: string,
		private render: ((target: HTMLElement, anchor: Comment) => MountedComponent) | null,
	) {
		// onLayoutReady callbacks cannot be unregistered; Obsidian may invoke
		// this after destroy() when the plugin unloads before layout settles.
		this.workspace.onLayoutReady(() => {
			if (this.destroyed) return;
			this.layoutReady = true;
			this.sync();
		});

		const ref = this.workspace.on("layout-change", () => this.sync());
		this.offLayoutChange = () => {
			this.workspace.offref(ref);
		};

		this.refreshInterval = window.setInterval(() => this.sync(), 10_000);
	}

	private sync(): void {
		if (this.destroyed || !this.layoutReady) return;

		if (this.component && !this.anchor?.isConnected) {
			this.unmount();
		}
		if (!this.component) {
			this.mount();
		}
	}

	private mount(): void {
		const vaultProfile = this.findVaultProfile();
		const target = vaultProfile?.parentElement;
		if (!vaultProfile || !target) return;

		Array.from(target.children)
			.filter((el) => el.classList.contains(this.slotClass))
			.forEach((el) => el.remove());

		// A comment keeps the insertion point without becoming a sidebar flex
		// item. The component only renders an element while its notice is visible.
		this.anchor = target.ownerDocument.createComment(this.slotClass);
		target.insertBefore(this.anchor, vaultProfile);

		this.component = this.render!(target, this.anchor);
	}

	private findVaultProfile(): HTMLElement | null {
		return this.workspace.containerEl.querySelector<HTMLElement>(
			".workspace-split.mod-left-split .workspace-sidedock-vault-profile",
		);
	}

	private unmount(): void {
		this.component?.destroy();
		this.component = null;
		this.anchor?.remove();
		this.anchor = null;
	}

	destroy(): void {
		this.destroyed = true;
		if (this.refreshInterval !== null) {
			window.clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
		this.offLayoutChange?.();
		this.offLayoutChange = null;
		this.unmount();
		this.workspace = null as unknown as typeof this.workspace;
		this.render = null;
	}
}
