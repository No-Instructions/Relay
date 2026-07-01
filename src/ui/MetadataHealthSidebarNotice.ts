import { Workspace } from "obsidian";
import MetadataHealthNotice from "../components/MetadataHealthNotice.svelte";
import type { MetadataHealth } from "../MetadataHealth";

export class MetadataHealthSidebarNoticeMount {
	private component: MetadataHealthNotice | null = null;
	private containerEl: HTMLElement | null = null;
	private offLayoutChange: (() => void) | null = null;
	private refreshInterval: number | null = null;
	private layoutReady = false;

	constructor(
		private workspace: Workspace,
		private metadataHealth: MetadataHealth,
	) {
		this.workspace.onLayoutReady(() => {
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
		if (!this.layoutReady) return;

		if (this.component && !this.containerEl?.isConnected) {
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
			.filter((el) => el.classList.contains("system3-metadata-health-slot"))
			.forEach((el) => el.remove());

		this.containerEl = target.ownerDocument.createElement("div");
		this.containerEl.classList.add("system3-metadata-health-slot");
		this.containerEl.style.order = "1";
		this.containerEl.style.flex = "0 0 auto";
		this.containerEl.style.height = "auto";
		this.containerEl.style.minHeight = "0";
		this.containerEl.style.overflow = "visible";
		target.insertBefore(this.containerEl, vaultProfile);

		this.component = new MetadataHealthNotice({
			target: this.containerEl,
			props: {
				metadataHealth: this.metadataHealth,
			},
		});
	}

	private findVaultProfile(): HTMLElement | null {
		return this.workspace.containerEl.querySelector<HTMLElement>(
			".workspace-split.mod-left-split .workspace-sidedock-vault-profile",
		);
	}

	private unmount(): void {
		this.component?.$destroy();
		this.component = null;
		this.containerEl?.remove();
		this.containerEl = null;
	}

	destroy(): void {
		if (this.refreshInterval !== null) {
			window.clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
		this.offLayoutChange?.();
		this.offLayoutChange = null;
		this.unmount();
		this.workspace = null as any;
		this.metadataHealth = null as any;
	}
}
