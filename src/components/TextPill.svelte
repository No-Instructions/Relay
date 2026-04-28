<script lang="ts">
	export let text: string;
	export let label: string;
	export let onClick: (() => void) | undefined = undefined;

	function swallowEvent() {}
</script>

{#if onClick}
	<button
		type="button"
		class="nav-file-tag system3-filepill"
		aria-label={label}
		on:mousedown|stopPropagation={swallowEvent}
		on:click|stopPropagation|preventDefault={onClick}
	>
		<span>{text}</span>
	</button>
{:else}
	<div class="nav-file-tag system3-filepill" aria-label={label}>
		<span>{text}</span>
	</div>
{/if}

<style>
	.system3-filepill {
		text-wrap: nowrap;
	}

	button.system3-filepill {
		cursor: pointer;
		background: none;
		border: none;
		padding: 0;
		color: inherit;
		font: inherit;
		appearance: none;
	}
</style>
