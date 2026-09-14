<script lang="ts">
	import { minimark } from "src/minimark";
	import type Live from "src/main";
	export let plugin: Live;

	function openAnnouncement() {
		if (plugin.networkStatus.status?.versions) {
			plugin.openPluginPage();
			return;
		}
		const link = plugin.networkStatus.status?.link;
		if (!link) return;

		let url: URL | undefined;
		try {
			url = new URL(link);
		} catch {
			// Preserve the external-link behavior for URLs the parser cannot read.
		}
		if (
			url?.protocol === "obsidian:" &&
			((url.host === "relay" && url.pathname === "/upgrade") ||
				(url.host === "show-plugin" &&
					url.searchParams.get("id") === plugin.manifest.id))
		) {
			plugin.openPluginPage();
			return;
		}
		window.open(link);
	}
</script>

{#if plugin.networkStatus.status}
	<div
		class="modal-setting-nav-bar system3-announcement-banner"
		on:click={openAnnouncement}
		role="button"
		tabindex="0"
		on:keypress={openAnnouncement}
		style="background-color: {plugin.networkStatus.status.backgroundColor
			? plugin.networkStatus.status.backgroundColor
			: 'var(--color-accent)'} !important"
	>
		<span
			class="system3-announcement"
			style="color: {plugin.networkStatus.status.color
				? plugin.networkStatus.status.color
				: 'var(--text-on-accent)'} !important"
		>
			{#if plugin.networkStatus.status}
				{@html minimark(plugin.networkStatus.status.status)}
			{/if}
		</span>
	</div>
{/if}
