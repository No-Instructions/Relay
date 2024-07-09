<script lang="ts">
	import { Satellite, Layers } from "lucide-svelte";
	import type { ConnectionStatus } from "src/HasProvider";
	import type { RemoteSharedFolder } from "src/Relay";
	export let status: ConnectionStatus = "disconnected";
	export let remote: RemoteSharedFolder | undefined;
</script>

<div class="folder-icons">
	{#if remote}
		<span
			class="satellite system3-{status}"
			aria-label={`${remote.relay.name} (${status})`}
		>
			<Satellite class="inline-icon" />
		</span>
		<span class="notebook" aria-label="Tracking Changes">
			<Layers class="inline-icon" style="width: .8em" />
		</span>
	{:else}
		<span class="notebook" aria-label="Tracking Changes">
			<Layers class="inline-icon" style="width: .8em" />
		</span>
	{/if}
</div>

<style>
	.folder-icons {
		display: inline-flex;
		margin-left: auto;
		align-items: center;
		vertical-align: middle;
		overflow: hidden;
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
</style>
