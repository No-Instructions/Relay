<script lang="ts">
	import type { ServiceMessageAction } from "../ServiceMessages";
	export let actions: readonly ServiceMessageAction[] = [];
	export let onAction: (action: ServiceMessageAction) => void;
</script>

{#if actions.length}
	<span class="service-message-actions">
		{#each actions as action}
			<button type="button" on:click={() => onAction(action)}>{action.label}</button>
		{/each}
	</span>
{/if}

<style>
	.service-message-actions { display: flex; flex-wrap: wrap; gap: var(--size-4-2) var(--size-4-3); margin-top: var(--size-4-2); }
	button { appearance: none; background: none; border: 0; box-shadow: none; padding: 0; height: auto; color: var(--link-color); font-size: inherit; text-decoration: var(--link-decoration); cursor: pointer; }
	button:hover { color: var(--link-color-hover); text-decoration: var(--link-decoration-hover); }
</style>
