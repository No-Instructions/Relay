<script lang="ts">
	import { Activity, ArrowUp, Satellite, Layers, Unplug } from "lucide-svelte";
	import type { ConnectionStatus } from "src/HasProvider";
	import type { RemoteSharedFolder } from "src/Relay";
	export let status: ConnectionStatus = "disconnected";
	export let relayId: string | undefined;
	export let remote: RemoteSharedFolder | undefined;
	export let progress = 0;
	export let showProgress = false;
	export let localOnly: boolean = false;
	export let enableDraftMode: boolean = false;
	export let deletionsGated: boolean = false;
	export let pendingDeletions: number = 0;
	export let syncStatus: "pending" | "running" | "completed" | "failed" =
		"pending";

	$: effectiveLocalOnly = enableDraftMode && localOnly;
	$: satelliteClass = effectiveLocalOnly
		? "system3-paused"
		: `system3-${status}`;
	$: satelliteLabel = deletionsGated
		? `${remote?.relay.name || "Relay Server"} (${status}) — ${pendingDeletions} ${
				pendingDeletions === 1 ? "deletion" : "deletions"
			} pending`
		: effectiveLocalOnly
			? `${remote?.relay.name || "Relay Server"} (paused)`
			: `${remote?.relay.name || "Relay Server"} (${status})`;
</script>

<div class="system3-folder-icons" class:system3-gated-clickable={deletionsGated}>
	<!-- Always show progress while running, regardless of completion -->
	{#if showProgress}
		<span class="system3-progress-text system3-{syncStatus}" style="opacity: 1">
			{progress}%
		</span>
	{/if}
	{#if relayId}
		{#if !deletionsGated}
			<!-- The stack icon's hover reveal reads as noise next to the held
			     count, so it stays out of the pill while a burst is gated. -->
			<span class="notebook system3-icon hidden" aria-label="Tracking Changes">
				<Layers class="inline-icon" style="width: 0.8em" />
			</span>
		{/if}
		{#if deletionsGated && pendingDeletions > 0}
			<span class="system3-held-count">
				<span class="system3-held-digits">{pendingDeletions}</span><ArrowUp
					style="width: 1em; height: 1em; flex: none"
				/>
			</span>
		{/if}
		<span
			class="satellite system3-icon {satelliteClass}"
			aria-label={satelliteLabel}
		>
			{#if enableDraftMode}
				<Activity class="inline-icon" style="width: 0.8em" />
			{:else}
				<Satellite class="inline-icon" />
			{/if}
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
	span.system3-paused {
		color: var(--color-yellow);
	}
	/* Held deletions read as pending outbound ops: a red count with an
	   outbound arrow ("28↑") beside the folder's ordinary connection icon —
	   the folder itself is neither paused nor disconnected, so the icon
	   stays truthful. The arrow is an SVG sized to the count's font so the
	   pair centers on one text line inside the pill's short row instead of
	   a text arrow glyph riding above the number's line box. */
	.system3-held-count {
		color: var(--color-red);
		font-size: 0.75em;
		margin-right: 0.35em;
		font-variant-numeric: tabular-nums;
		line-height: 1;
		display: inline-flex;
		align-items: center;
	}
	/* Digits have no descenders, so their ink paints high of the flex
	   center by ~1px at this size; the arrow SVG centers exactly. Nudge
	   only the digits. */
	.system3-held-digits {
		transform: translateY(1px);
	}
	.system3-gated-clickable {
		cursor: pointer;
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
