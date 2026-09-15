<script lang="ts">
	import { onDestroy } from "svelte";
	import type { ServiceStatus } from "src/NetworkStatus";
	import { minimark } from "src/minimark";
	import type Live from "src/main";
	import ServiceMessageActions from "./ServiceMessageActions.svelte";
	export let plugin: Live;
	let status: ServiceStatus | undefined;
	const unsubscribe = plugin.networkStatus.subscribeServiceStatus(next => { status = next; });
	onDestroy(unsubscribe);

	function showRelease() {
		if (status?.versions) {
			if (plugin.releaseSettings.get().channel === "stable") {
				plugin.openReleaseManager(status.versions.stable);
			} else if (plugin.releaseSettings.get().channel === "beta") {
				plugin.openReleaseManager(status.versions.beta);
			}
		}
	}
</script>

{#if status}
	<div
		class="modal-setting-nav-bar system3-announcement-banner"
		style:background-color={status.backgroundColor ?? "var(--color-accent)"}
		style:color={status.color ?? "var(--text-on-accent)"}
	>
		{#if status.versions || status.link}
			<button class="announcement-primary" type="button" on:click={() => {
				if (status?.versions) showRelease();
				else if (status?.link) window.open(status.link, "_blank", "noopener,noreferrer");
			}}><span class="system3-announcement">{@html minimark(status.status)}</span></button>
		{:else}
			<span class="system3-announcement">{@html minimark(status.status)}</span>
		{/if}
		<ServiceMessageActions actions={status.actions ?? []} onAction={action => { void plugin.openServiceMessageAction(action); }} />
	</div>
{/if}

<style>
	.system3-announcement-banner { display: block; }
	.system3-announcement { color: inherit; }
	.system3-announcement-banner :global(.service-message-actions button) { color: inherit; text-decoration: underline; }
	.announcement-primary { background: none; border: 0; box-shadow: none; padding: 0; height: auto; width: 100%; color: inherit; font-size: inherit; text-align: inherit; cursor: pointer; }
</style>
