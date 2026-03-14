<script lang="ts">
	import { LiveView } from "../LiveViews";
	import type { ConnectionState, ConnectionStatus } from "../HasProvider";
	import type { Document } from "src/Document";
	import type { RemoteSharedFolder } from "src/Relay";
	import { Activity, CloudOff, Layers, Satellite, Unplug, UserRoundX } from "lucide-svelte";

	export let view: LiveView;
	export let state: ConnectionState;
	export let remote: RemoteSharedFolder;
	export let tracking: boolean = false;
	export let localOnly: boolean = false;
	export let isLoggedOut: boolean = false;
	export let onLogin: (() => Promise<boolean>) | undefined = undefined;
	export let enableDraftMode: boolean = false;
	export let folderConnected: boolean = false;
	export let pendingOutbound: number = 0;
	export let pendingInbound: number = 0;

	$: opsFlowing = state.status === "connected" && !localOnly;

	// Draft mode: use folder-level connection as the default so the icon
	// doesn't flash CloudOff while the individual doc is still connecting.
	$: draftActive = !localOnly && (opsFlowing || folderConnected);
	$: draftIconClass = localOnly
		? "system3-paused"
		: draftActive
			? "system3-connected"
			: "system3-disconnected";
	$: draftLabel = localOnly
		? `${remote?.relay?.name || "Relay"} (draft)`
		: draftActive
			? `${remote?.relay?.name || "Relay"} (connected)`
			: `${remote?.relay?.name || "Relay"} (disconnected)`;

	// Legacy mode (flag off): satellite icon with connection status
	$: satelliteClass = opsFlowing
		? "system3-connected"
		: localOnly ? "system3-paused" : `system3-${state.status}`;
	$: satelliteLabel = opsFlowing
		? `${remote?.relay?.name || "Relay"} (connected)`
		: localOnly
			? `${remote?.relay?.name || "Relay"} (paused)`
			: `${remote?.relay?.name || "Relay"} (${state.status})`;

	const handleClick = () => {
		if (isLoggedOut && onLogin) {
			onLogin();
		} else if (enableDraftMode) {
			view.toggleLocalOnly();
		} else {
			view.toggleConnection();
		}
	};

	const handleKeyPress = (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			handleClick();
		}
	};

	const handleLayersClick = async () => {
		// Disk buffer feature removed - this button is now a no-op
	};

	const handleLayersKeyPress = (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			handleLayersClick();
		}
	};
</script>

{#if isLoggedOut}
	<button
		class="clickable-icon view-action system3-view-action mod-warning"
		aria-label="Login to enable Live edits"
		tabindex="0"
		on:click={handleClick}
		on:keypress={handleKeyPress}
	>
		<UserRoundX class="svg-icon inline-icon" />
	</button>
{:else if remote}
	{#if !enableDraftMode}
		<button
			class="clickable-icon view-action system3-view-action {tracking
				? 'notebook-synced'
				: 'notebook'}"
			aria-label={tracking
				? "Tracking changes: local file and update log are in sync"
				: "Not tracking changes: local file and update log are not in sync -- click to check"}
			tabindex="0"
			data-filename={view.view.file?.name}
			on:click={handleLayersClick}
			on:keypress={handleLayersKeyPress}
		>
			<Layers class="svg-icon inline-icon" />
		</button>
	{/if}
	{#if enableDraftMode}
		<button
			class="{draftIconClass} clickable-icon view-action system3-view-action"
			aria-label={draftLabel}
			tabindex="0"
			on:click={handleClick}
			on:keypress={handleKeyPress}
		>
			{#if localOnly}
				<Unplug class="svg-icon inline-icon" />
			{:else if draftActive}
				<Activity class="svg-icon inline-icon" />
			{:else}
				<CloudOff class="svg-icon inline-icon" />
			{/if}
			{#if pendingOutbound > 0 || pendingInbound > 0}
				<span class="system3-pending-count"
					>{#if pendingOutbound > 0}{pendingOutbound}&#x2191;{/if}{#if pendingInbound > 0}{pendingInbound}&#x2193;{/if}</span>
			{/if}
		</button>
	{:else}
		<button
			class="{satelliteClass} clickable-icon view-action system3-view-action"
			aria-label={satelliteLabel}
			tabindex="0"
			on:click={handleClick}
			on:keypress={handleKeyPress}
		>
			<Satellite class="svg-icon inline-icon" />
		</button>
	{/if}
{:else if !enableDraftMode}
	<button
		class="clickable-icon view-action system3-view-action {tracking
			? 'notebook-synced'
			: 'notebook'}"
		aria-label={tracking
			? "Tracking changes: local file and update log are in sync"
			: "Not tracking changes: local file and update log are not in sync -- click to check"}
		tabindex="0"
		data-filename={view.view.file?.name}
		on:click={handleLayersClick}
		on:keypress={handleLayersKeyPress}
	>
		<Layers class="svg-icon inline-icon" />
	</button>
{/if}

<style>
	button.notebook {
		color: var(--color-base-40);
		background-color: transparent;
	}
	button.notebook-synced {
		color: var(--color-accent);
	}
	button.system3-connected {
		color: var(--color-accent);
	}
	button.system3-disconnected {
		color: var(--color-base-40);
	}
	button.system3-paused {
		color: var(--color-base-40);
	}
	.system3-pending-count {
		font-size: 0.75em;
		margin-left: 0.15em;
	}
</style>
