<script lang="ts">
	import { Folder, ArrowRightLeft, Satellite } from "lucide-svelte";
	import type { SharedFolder } from "src/SharedFolder";

	export let folder: SharedFolder;
</script>

<span style="display: inline-flex; align-items: center">
	<Folder
		size={16}
		class="svg-icon"
		style="margin-right: .2em; flex-shrink: 0;"
	/>
	{folder.name}

	{#if folder.remote}
		<ArrowRightLeft
			size={16}
			class="svg-icon"
			style="margin: 0 1em; flex-shrink: 0;"
		/>
		<Satellite size={16} class="svg-icon" style="flex-shrink: 0;" />
		<span>
			{folder.remote.relay.name}
		</span>
	{/if}
</span>
