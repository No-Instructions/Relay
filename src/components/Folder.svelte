<script lang="ts">
	import { Folder } from "lucide-svelte";
	import { type SharedFolder } from "../SharedFolder";
	import { type RemoteSharedFolder } from "../Relay";
	import { createEventDispatcher } from "svelte";
	export let folder: SharedFolder | undefined = undefined;
	export let remoteFolder: RemoteSharedFolder | undefined = undefined;

	const dispatch = createEventDispatcher();
	function manageSharedFolder(): void {
		if (folder) {
			dispatch("manageSharedFolder", {
				folder: folder,
				relay: folder?.remote?.relay || remoteFolder?.relay,
				remoteFolder: remoteFolder,
			});
		}
	}
</script>

<span
	role="button"
	tabindex="0"
	on:keypress={manageSharedFolder}
	on:click={manageSharedFolder}
	style="display: inline-flex; align-items: center; width: 100%"
>
	<Folder class="svg-icon" style="margin-right: .2em; flex-shrink: 0" />
	<slot></slot>
</span>
