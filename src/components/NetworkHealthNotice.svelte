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
		Native network requests are failing.
		Try turning off native networking in Relay settings.
	{:else}
		Obsidian's network requests are failing. Please restart Obsidian.
	{/if}
</ObsidianFailureNotice>
