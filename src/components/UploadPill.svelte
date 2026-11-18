<script lang="ts">
	export let text: string;
	export let label: string;
	export let color: string | undefined = undefined;
	export let openSettings: (() => void) | undefined = undefined;
	// The declared status is a closed vocabulary, never the display text:
	// consumers must be able to match it without pinning human copy.
	export let status: "pending" | "error" | "unknown" | undefined = undefined;
</script>

{#if openSettings}
	<button type="button" class="nav-file-tag system3-uploadpill" data-status={status}
		aria-label={label + ". Open upload settings"} on:click|stopPropagation={() => openSettings?.()}>
		{text}
	</button>
{:else}
<div
	class="nav-file-tag system3-uploadpill"
	aria-label={label}
	data-status={status}
	style={color ? `color:${color}` : ""}
>
	<span>{text}</span>
</div>
{/if}

<style>
	.system3-uploadpill {
		text-wrap: nowrap;
	}
</style>
