<script lang="ts">
	import { Folder } from "lucide-svelte";
	import { createEventDispatcher } from "svelte";
	import { type SharedFolder } from "../SharedFolder";

	export let folder: SharedFolder | undefined = undefined;

	const dispatch = createEventDispatcher();
	function manageSharedFolder(): void {
		if (folder) {
			dispatch("manageSharedFolder", {
				folder: folder,
				relay: folder.remote?.relay,
			});
		}
	}
</script>

<span
	role="button"
	tabindex="0"
	on:keypress={manageSharedFolder}
	on:click={manageSharedFolder}
	style="display: inline-flex; align-items: center"
>
	<Folder class="svg-icon" style="margin-right: .2em;" />
	<slot></slot>
</span>
