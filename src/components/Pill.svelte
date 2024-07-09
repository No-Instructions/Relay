<script lang="ts">
	import { Satellite, Layers } from "lucide-svelte";
	import type { ConnectionStatus } from "src/HasProvider";

	export let status: ConnectionStatus = "disconnected";
	export let hasRelay: boolean;
</script>

<div class="system3-pill system3-{status}">
	{#if hasRelay}
		<span class="satellite" aria-label={`Relay ${status}`}
			><Satellite class="svg-icon" style="width: 1.5em" /></span
		>
		<span class="notebook" aria-label="Tracking Changes">
			<Layers class="svg-icon" style="width: 1.2em" />
		</span>
	{:else}
		<span class="notebook" aria-label="Tracking Changes">
			<Layers class="svg-icon" style="width: 1.2em" />
		</span>
	{/if}
</div>

<style>
	.system3-pill > span.satellite {
		border-radius: var(--radius-s);
	}

	.system3-pill.system3-connected > span.satellite {
		color: var(--color-accent);
	}
	.system3-pill.system3-disconnected > span.satellite {
		color: var(--color-base-40);
	}

	.system3-pill > span.notebook {
		color: var(--color-accent);
	}

	.system3-pill {
		border: 1px solid transparent;
		position: absolute;
		right: 4px;
		top: 2px;
	}
</style>
