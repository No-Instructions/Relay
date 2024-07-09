<script lang="ts">
	export let checked: boolean;
	export let disabled: boolean;
	export let label: string;
</script>

<div class="checkbox-container" aria-label={label}>
	<input type="checkbox" tabindex="0" bind:checked {disabled} />
</div>
