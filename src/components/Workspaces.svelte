<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type { Workspace } from "../Workspace";
	export let workspaces: Workspace[] = [];

	const makeDescription = (workspace: Workspace) => {
		return `Role: ${workspace.role}\nUser Limit: ${workspace.user_limit}`;
	};

	const dispatch = createEventDispatcher();

	function handelManageWorkspace(workspace: Workspace) {
		dispatch("manageWorkspace", { workspace });
	}
	function handleJoinWorkspace(workspace: Workspace) {
		dispatch("joinWorkspace", { workspace });
	}
</script>

<SettingItemHeading name="Workspaces"></SettingItemHeading>
{#each workspaces as item}
	<SettingItem itemName={item.name} itemDescription={makeDescription(item)}>
		{#if item.role === "owner"}
			<button on:click={() => handelManageWorkspace(item)}>
				Manage
			</button>
		{:else}
			<button on:click={() => handleJoinWorkspace(item)}> Join </button>
		{/if}
	</SettingItem>
{/each}
