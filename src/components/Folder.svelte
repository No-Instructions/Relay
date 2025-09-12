<script lang="ts">
	import { FolderOpen } from "lucide-svelte";
	import { type SharedFolder } from "../SharedFolder";
	import { type RemoteSharedFolder } from "../Relay";
	import { createEventDispatcher } from "svelte";
	export let folder: SharedFolder | undefined = undefined;
	export let remoteFolder: RemoteSharedFolder | undefined = undefined;

	const dispatch = createEventDispatcher();
	function manageSharedFolder(): void {
		dispatch("manageSharedFolder", {
			folder: folder,
			remoteFolder: remoteFolder,
			relay: folder?.remote?.relay || remoteFolder?.relay,
		});
	}

</script>

<span
	role="button"
	tabindex="0"
	on:keypress={manageSharedFolder}
	on:click={manageSharedFolder}
	style="display: inline-flex; align-items: center; width: 100%"
>
	<FolderOpen class="svg-icon" style="margin-right: .2em; flex-shrink: 0" />
	<slot></slot>
</span>
