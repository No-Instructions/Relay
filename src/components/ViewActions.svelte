<script lang="ts">
	import { LiveView } from "../LiveViews";
	import type { ConnectionState, ConnectionStatus } from "../HasProvider";
	import type { Document } from "src/Document";
	import type { RemoteSharedFolder } from "src/Relay";
	import { Layers, Satellite, UserRoundX } from "lucide-svelte";

	export let view: LiveView;
	export let state: ConnectionState;
	export let remote: RemoteSharedFolder;
	export let tracking: boolean = false;
	export let localOnly: boolean = false;
	export let isLoggedOut: boolean = false;
	export let onLogin: (() => Promise<boolean>) | undefined = undefined;

	$: opsFlowing = state.status === "connected" && !localOnly;
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
	<button
		class="{satelliteClass} clickable-icon view-action system3-view-action"
		aria-label={satelliteLabel}
		tabindex="0"
		on:click={handleClick}
		on:keypress={handleKeyPress}
	>
		<Satellite class="svg-icon inline-icon" />
	</button>
{:else}
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
</style>
