<script lang="ts">
	import { Satellite, Layers } from "lucide-svelte";
	import type { ConnectionStatus } from "src/HasProvider";
	import type { RemoteSharedFolder } from "src/Relay";
	export let status: ConnectionStatus = "disconnected";
	export let relayId: string | undefined;
	export let remote: RemoteSharedFolder | undefined;
	export let progress = 0;
	export let syncStatus: "pending" | "running" | "completed" | "failed" =
		"pending";

	// Always show progress during any active state
	$: showProgress =
		(syncStatus !== "completed" || progress < 100) && progress > 0;
</script>

<div class="system3-folder-icons">
	<!-- Always show progress while running, regardless of completion -->
	{#if showProgress}
		<span class="system3-progress-text system3-{syncStatus}" style="opacity: 1">
			{progress}%
		</span>
	{/if}
	{#if relayId}
		<span class="notebook system3-icon hidden" aria-label="Tracking Changes">
			<Layers class="inline-icon" style="width: 0.8em" />
		</span>
		<span
			class="satellite system3-icon system3-{status}"
			aria-label={`${remote?.relay.name || "Relay Server"} (${status})`}
		>
			<Satellite class="inline-icon" />
		</span>
	{:else}
		<span class="notebook system3-icon" aria-label="Tracking Changes">
			<Layers class="inline-icon" style="width: 0.8em" />
		</span>
	{/if}
</div>

<style>
	.system3-folder-icons {
		display: inline-flex;
		align-items: center;
		vertical-align: middle;
		border-radius: var(--radius-m);
		transition: width 0.3s ease;
		margin-right: 0.6em;
		padding-left: 0.2em;
		padding-right: 0.2em;
		background-color: var(--color-base-05);
		position: relative;
	}

	.system3-icon {
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

	.system3-progress-text {
		margin-right: 0.4em;
		font-size: 0.8em;
		color: var(--color-accent);
		opacity: 1;
		transition: opacity 0.3s ease;
	}

	.system3-progress-text.completed {
		animation: fadeOutDelay 0.3s ease forwards;
	}

	.system3-progress-text.failed {
		color: var(--color-red);
	}

	@keyframes fadeOutDelay {
		0%,
		50% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			display: none;
		}
	}
</style>
