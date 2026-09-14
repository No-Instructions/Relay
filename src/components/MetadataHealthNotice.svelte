<script lang="ts">
	import { onDestroy } from "svelte";
	import type { MetadataHealth, MetadataHealthState } from "src/MetadataHealth";
	import ObsidianFailureNotice from "./ObsidianFailureNotice.svelte";

	export let metadataHealth: MetadataHealth;
	export let slotClass = "system3-metadata-health-slot";
	let state: MetadataHealthState = metadataHealth.state;
	const unsubscribe = metadataHealth.subscribe(health => { state = health.state; });
	onDestroy(unsubscribe);
</script>

<ObsidianFailureNotice
	active={state.status === "metadata-db-locked"}
	title="Obsidian metadata database is locked"
	dismissLabel="Dismiss metadata database warning"
	className="metadata-health-notice"
	{slotClass}
>
	Relay detected that Obsidian's metadata database is locked. Restart Obsidian
	to restore indexing.
</ObsidianFailureNotice>
