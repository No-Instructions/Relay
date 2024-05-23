<script lang="ts">
	import { LiveView } from "../LiveViews";
	import type { ConnectionState, ConnectionStatus } from "../HasProvider";

	export let state: ConnectionState;

	export let view: LiveView;

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

<span
	class="connection-status-icon"
	aria-label={ariaLabels[state.status]}
	role="button"
	tabindex="0"
	data-filename={view.view.file?.name}
	on:click={handleClick}
	on:keypress={handleKeyPress}
>
	<span class={"connection-status-icon-" + state.status}>●</span>
</span>

<style>
	.connection-status-icon span.unknown {
		color: grey;
	}
	.connection-status-icon span.connected {
		color: green;
	}
	.connection-status-icon span.disconnected {
		color: red;
	}
</style>
