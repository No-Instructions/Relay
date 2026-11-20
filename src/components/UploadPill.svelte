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
	<button type="button" class="nav-file-tag system3-uploadpill system3-pill-button" data-status={status}
		aria-label={label + ". Change upload limit"} on:click|stopPropagation={() => openSettings?.()}>
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
	button.system3-uploadpill {
		display: block;
		max-width: 50%;
		height: auto;
		overflow: hidden;
		text-overflow: ellipsis;
		box-shadow: none;
	}
</style>
