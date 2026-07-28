<script lang="ts">
	export let text: string;
	export let label: string;
	export let color: string | undefined;
	// The declared status is a closed vocabulary, never the display text:
	// consumers must be able to match it without pinning human copy.
	export let status: "pending" | "error" | "unknown" | undefined = undefined;
</script>

<div
	class="nav-file-tag system3-uploadpill"
	aria-label={label}
	data-status={status}
	style={color ? `color:${color}` : ""}
>
	<span>{text}</span>
</div>

<style>
	.system3-uploadpill {
		text-wrap: nowrap;
	}
</style>
