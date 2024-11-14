<script lang="ts">
	import { ArrowRightLeft } from "lucide-svelte";
	import type { Relay } from "src/Relay";
	import type { SharedFolder } from "src/SharedFolder";
	import Satellite from "./Satellite.svelte";
	import Folder from "./Folder.svelte";
	export let folder: SharedFolder;
	export let relay: Relay | undefined;
</script>

<span style="display: inline-flex; align-items: center; width: 100%; gap: 8px;">
	<!-- Column 1: Folder -->
	<span
		style="display: inline-flex; align-items: center; width: 200px; min-width: 200px; flex-shrink: 0;"
	>
		<Folder {folder} on:manageSharedFolder>
			<span
				style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
			>
				{folder.name}
			</span>
		</Folder>
	</span>

	{#if folder.remote}
		<!-- Column 2: Arrow -->
		<span
			style="width: 16px; flex-shrink: 0; display: flex; justify-content: center;"
		>
			<ArrowRightLeft size={16} class="svg-icon" />
		</span>

		<!-- Column 3: Relay -->
		<Satellite on:manageRelay {relay}>
			<span
				style="flex: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap;"
			>
				{folder.remote.relay.name}
			</span>
		</Satellite>
	{/if}
</span>
