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

	function settingsCloseColor(element: HTMLElement, color: string | undefined) {
		const modal = element.closest<HTMLElement>(".modal.mod-settings");
		if (!modal) return;
		const property = "--relay-announcement-color";
		const previous = modal.style.getPropertyValue(property);
		const update = (color: string | undefined) => {
			modal.style.setProperty(property, color ?? "var(--text-on-accent)");
		};
		update(color);
		return {
			update,
			destroy() {
				if (previous) modal.style.setProperty(property, previous);
				else modal.style.removeProperty(property);
			},
		};
	}

	function showRelease() {
		if (status?.versions) {
			if (plugin.releaseSettings.get().channel === "beta") {
				plugin.openReleaseManager(status.versions.beta);
			} else {
				plugin.openPluginPage();
			}
		}
	}
</script>

{#if status}
	<div
		class="system3-announcement-banner"
		use:settingsCloseColor={status.color}
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
	:global(.modal.mod-settings:has(.relay-settings > .system3-announcement-banner) > :is(.modal-header-button, .modal-close-button):not(.mod-start)) {
		color: var(--relay-announcement-color);
	}

	.system3-announcement-banner {
		flex: 0 0 auto;
		min-width: 0;
		padding: var(--size-4-3) var(--size-4-12);
		font-size: var(--font-ui-small);
		line-height: var(--line-height-normal);
		overflow-wrap: anywhere;
	}

	.system3-announcement {
		display: block;
		color: inherit;
	}

	.system3-announcement-banner :global(.service-message-actions button) {
		min-width: 0;
		color: inherit;
		line-height: inherit;
		white-space: normal;
		text-align: inherit;
		text-decoration: underline;
	}

	.announcement-primary {
		display: block;
		background: none;
		border: 0;
		box-shadow: none;
		padding: 0;
		height: auto;
		width: 100%;
		color: inherit;
		font-size: inherit;
		line-height: inherit;
		text-align: inherit;
		white-space: normal;
		cursor: pointer;
	}

	:global(.is-mobile) .system3-announcement-banner {
		padding-inline: var(--size-4-4);
	}
</style>
