<script lang="ts">
	import { onDestroy } from "svelte";
	import type NetworkStatus from "src/NetworkStatus";
	import type { NetworkTransportFailure } from "src/NetworkStatus";
	import ObsidianFailureNotice from "./ObsidianFailureNotice.svelte";

	export let networkStatus: NetworkStatus;
	export let slotClass = "system3-network-health-slot";
	let failure: NetworkTransportFailure = networkStatus.transportFailure;
	const unsubscribe = networkStatus.subscribeTransportFailure(next => { failure = next; });
	onDestroy(unsubscribe);
</script>

<ObsidianFailureNotice
	active={failure !== null}
	title={failure === "node" ? "Native networking is unavailable" : "Obsidian networking is unavailable"}
	dismissLabel="Dismiss networking warning"
	className="network-health-notice"
	{slotClass}
>
	{#if failure === "node"}
		Relay can reach its service, but native networking is failing.
		Try turning off native networking in Relay settings.
	{:else}
		Relay can reach its service, but Obsidian's network requests are failing.
		Restart Obsidian to try to restore the connection.
	{/if}
</ObsidianFailureNotice>
