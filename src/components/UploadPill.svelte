<script lang="ts">
	export let text: string;
	export let label: string;
	export let color: string | undefined;
</script>

<div
	class="nav-file-tag system3-uploadpill"
	aria-label={label}
	style={color ? `color:${color}` : ""}
>
	<span>{text}</span>
</div>

<style>
	.system3-uploadpill {
		text-wrap: nowrap;
	}
</style>
