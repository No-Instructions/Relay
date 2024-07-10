<script lang="ts">
	import { Satellite, Layers } from "lucide-svelte";
	import type { ConnectionStatus } from "src/HasProvider";
	import type { RemoteSharedFolder } from "src/Relay";
	export let status: ConnectionStatus = "disconnected";
	export let remote: RemoteSharedFolder | undefined;
</script>

<div class="folder-icons">
	{#if remote}
		<span class="notebook icon hidden" aria-label="Tracking Changes">
			<Layers class="inline-icon" style="width: 0.8em" />
		</span>
		<span
			class="satellite icon system3-{status}"
			aria-label={`${remote.relay.name} (${status})`}
		>
			<Satellite class="inline-icon" />
		</span>
	{:else}
		<span class="notebook icon" aria-label="Tracking Changes">
			<Layers class="inline-icon" style="width: 0.8em" />
		</span>
	{/if}
</div>

<style>
	.folder-icons {
		display: inline-flex;
		align-items: center;
		vertical-align: middle;
		border-radius: var(--radius-m);
		transition: width 0.3s ease;
		margin-right: 0.6em;
		padding-left: 0.2em;
		padding-right: 0.2em;
		background-color: var(--color-base-05);
	}

	.icon {
		margin-right: 0.2em;
		margin-left: 0.2em;
		width: 1em;
		display: flex;
		transition: display 0.3s ease;
	}

	span.system3-connected {
		color: var(--color-accent);
	}
	span.system3-disconnected {
		color: var(--color-base-40);
	}
	span.notebook {
		color: var(--color-accent);
	}

	span.hidden {
		display: none;
	}
</style>
