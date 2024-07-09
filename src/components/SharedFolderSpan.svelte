<script lang="ts">
	import { Folder, ArrowRightLeft, Satellite } from "lucide-svelte";
	import type { SharedFolder } from "src/SharedFolder";

	export let folder: SharedFolder;
</script>

<span style="display: inline-flex; align-items: center">
	<Folder
		class="svg-icon"
		style="margin-right: .2em; width: 1em;"
	/>{folder.name}
	{#if folder.remote}
		<ArrowRightLeft class="svg-icon" style="margin: 0 1em" />
		<Satellite class="svg-icon" />{folder.remote.relay.name}
	{/if}
</span>
