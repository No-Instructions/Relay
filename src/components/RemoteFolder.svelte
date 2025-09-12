<script lang="ts">
	import { Folder, FolderLock } from "lucide-svelte";
	import { type RemoteSharedFolder } from "../Relay";
	import { createEventDispatcher } from "svelte";
	export let remoteFolder: RemoteSharedFolder;

	const dispatch = createEventDispatcher();
	function manageRemoteFolder(): void {
		dispatch("manageRemoteFolder", {
			remoteFolder: remoteFolder,
			relay: remoteFolder?.relay,
		});
	}
</script>

<span
	role="button"
	tabindex="0"
	on:keypress={manageRemoteFolder}
	on:click={manageRemoteFolder}
	style="display: inline-flex; align-items: center; width: 100%"
>
	{#if remoteFolder?.private}
		<FolderLock class="svg-icon" style="margin-right: .2em; flex-shrink: 0" />
	{:else}
		<Folder class="svg-icon" style="margin-right: .2em; flex-shrink: 0" />
	{/if}
	<slot></slot>
</span>