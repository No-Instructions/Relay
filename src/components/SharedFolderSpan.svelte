<script lang="ts">
	import { Folder, ArrowRightLeft, Satellite } from "lucide-svelte";
	import type { SharedFolder } from "src/SharedFolder";
	export let folder: SharedFolder;
</script>

<span style="display: inline-flex; align-items: center; width: 100%;">
	<!-- Column 1: Folder -->
	<span style="display: inline-flex; align-items: center; width: 200px;">
		<Folder
			size={16}
			class="svg-icon"
			style="margin-right: .2em; flex-shrink: 0;"
		/>
		<span
			style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
		>
			{folder.name}
		</span>
	</span>

	{#if folder.remote}
		<!-- Column 2: Arrow -->
		<ArrowRightLeft size={16} class="svg-icon" style="flex-shrink: 0;" />

		<!-- Column 3: Relay -->
		<span style="display: inline-flex; align-items: center; margin-left: 1em;">
			<Satellite
				size={16}
				class="svg-icon"
				style="margin-right: .2em; flex-shrink: 0;"
			/>
			<span
				style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
			>
				{folder.remote.relay.name}
			</span>
		</span>
	{/if}
</span>
