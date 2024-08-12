<script lang="ts">
	import { LiveView } from "../LiveViews";
	import type { ConnectionState, ConnectionStatus } from "../HasProvider";
	import type { Document } from "src/Document";
	import type { RemoteSharedFolder } from "src/Relay";
	import { Layers, Satellite } from "lucide-svelte";

	export let view: LiveView;
	export let document: Document;
	export let state: ConnectionState;
	let remote: RemoteSharedFolder;

	if (document?.sharedFolder?.remote) {
		remote = document.sharedFolder.remote;
	}

	const ariaLabels: Record<ConnectionStatus, string> = {
		connected: "connected: click to go offline",
		connecting: "connecting...",
		disconnected: "disconnected: click to go online",
		unknown: "unknown status",
	};

	const handleClick = () => {
		view.toggleConnection();
	};

	const handleKeyPress = (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			handleClick();
		}
	};
</script>

{#if remote}
	<button
		class="hidden notebook clickable-icon view-action system3-view-action"
		aria-label="Tracking Changes"
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
		class="notebook clickable-icon view-action"
		aria-label="Tracking Changes"
		tabindex="0"
		data-filename={view.view.file?.name}
	>
		<Layers class="svg-icon inline-icon" />
	</button>
{/if}

<style>
	button.system3-connected {
		color: var(--color-accent);
	}
	button.system3-disconnected {
		color: var(--color-base-40);
	}
	button.notebook {
		color: var(--color-base-30);
		background-color: transparent;
	}
</style>
