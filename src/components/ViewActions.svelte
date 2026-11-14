<script lang="ts">
	import type { LiveView, RelayCanvasView } from "../LiveViews";
	import type { ConnectionState } from "../HasProvider";
	import type { RemoteSharedFolder } from "src/Relay";
	import { CloudOff, Satellite, Unplug, UserRoundX } from "lucide-svelte";

	export let view: LiveView | RelayCanvasView;
	export let state: ConnectionState;
	export let remote: RemoteSharedFolder;
	export let readerMode: boolean = false;
	export let draftMode: boolean = false;
	export let isLoggedOut: boolean = false;
	export let onLogin: (() => Promise<boolean>) | undefined = undefined;
	export let folderConnected: boolean = false;
	export let pendingOutbound: number = 0;
	export let pendingInbound: number = 0;

	$: opsFlowing = state.status === "connected" && !draftMode;

	// Draft mode: use folder-level connection as the default so the icon
	// doesn't flash CloudOff while the individual doc is still connecting.
	$: draftActive = !draftMode && (opsFlowing || folderConnected);
	$: draftIconClass = draftMode
		? "system3-paused"
		: draftActive
			? "system3-connected"
			: "system3-disconnected";
	$: draftLabel = draftMode
		? `${remote?.relay?.name || "Relay"} (draft)`
		: draftActive
			? `${remote?.relay?.name || "Relay"} (connected)`
			: `${remote?.relay?.name || "Relay"} (disconnected)`;

	const handleClick = () => {
		if (isLoggedOut && onLogin) {
			onLogin();
		} else {
			view.toggleLocalOnly();
		}
	};

	const handleKeyPress = (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			handleClick();
		}
	};
</script>

{#if readerMode}
	<!-- ReaderModeAction installs the read-only indicator in the mode-button slot. -->
{:else if isLoggedOut}
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
	<button
		class="{draftIconClass} clickable-icon view-action system3-view-action"
		aria-label={draftLabel}
		tabindex="0"
		on:click={handleClick}
		on:keypress={handleKeyPress}
	>
		{#if draftMode}
			<Unplug class="svg-icon inline-icon" />
		{:else if draftActive}
			<Satellite class="svg-icon inline-icon" />
		{:else}
			<CloudOff class="svg-icon inline-icon" />
		{/if}
		{#if pendingOutbound > 0 || pendingInbound > 0}
			<span class="system3-pending-count"
				>{#if pendingOutbound > 0}{pendingOutbound}&#x2191;{/if}{#if pendingInbound > 0}{pendingInbound}&#x2193;{/if}</span>
		{/if}
	</button>
{/if}

<style>
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
