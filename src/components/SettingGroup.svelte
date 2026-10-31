<script lang="ts">
	import { requireApiVersion } from "obsidian";

	export let list = false;

	// Check if we should use the new setting-group layout
	const useGroupLayout = requireApiVersion("1.11.0");
</script>

{#if useGroupLayout}
	<div class="setting-group" class:mod-list={list}>
		<div class="setting-items">
			<slot></slot>
		</div>
	</div>
{:else}
	<slot></slot>
{/if}
