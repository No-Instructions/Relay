<script lang="ts">
	export let text: string;
	export let label: string;
</script>

<div class="nav-file-tag system3-filepill" aria-label={label}>
	<span>{text}</span>
</div>

<style>
	.system3-filepill {
		text-wrap: nowrap;
	}
</style>
