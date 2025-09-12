<script lang="ts">
	import { ArrowRightLeft } from "lucide-svelte";
	import type { SharedFolder } from "src/SharedFolder";
	import Folder from "./Folder.svelte";
	import Satellite from "./Satellite.svelte";
	import RemoteFolder from "./RemoteFolder.svelte";
	export let folder: SharedFolder;
</script>

<span style="display: inline-flex; align-items: center; width: 100%; gap: 8px;">
	<span
		style="display: inline-flex; align-items: center; width: 200px; min-width: 200px; flex-shrink: 0;"
	>
		{#if folder.remote}
			<RemoteFolder on:manageRemoteFolder remoteFolder={folder.remote}>
				<span
					style="flex: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap;"
				>
					{folder.name}
				</span>
			</RemoteFolder>
		{:else}
			<Folder {folder} on:manageSharedFolder>
				<span
					style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
				>
					{folder.name}
				</span>
			</Folder>
		{/if}
	</span>

	{#if folder.remote}
		<span
			style="width: 16px; flex-shrink: 0; display: flex; justify-content: center;"
		>
			<ArrowRightLeft size={16} class="svg-icon" />
		</span>

		<Satellite on:manageRelay relay={folder.remote.relay}>
			<span
				style="flex: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap;"
			>
				{folder.remote.relay.name}
			</span>
		</Satellite>
	{/if}
</span>
