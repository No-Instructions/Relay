<script lang="ts">
	import { LiveView } from "../LiveViews";
	import type { ConnectionState, ConnectionStatus } from "../HasProvider";
	import type { Document } from "src/Document";
	import type { RemoteSharedFolder } from "src/Relay";
	import { Layers, Satellite, UserRoundX } from "lucide-svelte";

	export let view: LiveView;
	export let state: ConnectionState;
	export let remote: RemoteSharedFolder;
	export let isLoggedOut: boolean = false;
	export let onLogin: (() => Promise<boolean>) | undefined = undefined;

	const ariaLabels: Record<ConnectionStatus, string> = {
		connected: "connected: click to go offline",
		connecting: "connecting...",
		disconnected: "disconnected: click to go online",
		unknown: "unknown status",
	};

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
		class="clickable-icon view-action system3-view-action {view.tracking
			? 'notebook-synced'
			: 'notebook'}"
		aria-label={view.tracking
			? "Tracking changes: local file and update log are in sync"
			: "Not tracking changes: local file and update log are not in sync"}
		tabindex="0"
		data-filename={view.view.file?.name}
	>
		<Layers class="svg-icon inline-icon" />
	</button>
	<button
		class="system3-{state.status} clickable-icon view-action system3-view-action"
		aria-label={`${remote.relay.name} (${state.status})`}
		tabindex="0"
		on:click={handleClick}
		on:keypress={handleKeyPress}
	>
		<Satellite class="svg-icon inline-icon" />
	</button>
{:else}
	<button
		class="clickable-icon view-action system3-view-action {view.tracking
			? 'notebook-synced'
			: 'notebook'}"
		aria-label={view.tracking
			? "Tracking changes: local file and update log are in sync"
			: "Not tracking changes: local file and update log are not in sync"}
		tabindex="0"
		data-filename={view.view.file?.name}
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
</style>
