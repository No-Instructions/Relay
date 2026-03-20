<script lang="ts">
	/**
	 * A compact resource usage indicator with hover popover.
	 *
	 * Displays colored bars representing slot utilization.
	 * All filled bars share one color based on overall utilization:
	 *   - green: plenty of headroom
	 *   - yellow: mostly used
	 *   - red: maxed out
	 *   - empty slots: gray
	 *
	 * On hover, a popover shows a labeled progress bar with usage details.
	 */

	export let label = "Resource Usage";
	export let used = 0;
	export let total = 3;
	export let itemLabel = "Slots";
	export let helpText = "";

	/** Number of queued items waiting for a slot */
	export let pending = 0;

	let isVisible = false;
	let containerEl: HTMLDivElement;
	let popoverEl: HTMLDivElement;
	let position: "above" | "below" = "below";

	$: pct = total > 0 ? used / total : 0;
	$: percent = Math.round(pct * 100);

	// 3 bars with individual colors based on utilization thresholds
	$: bar1 = pct >= 0.3 ? "green" : "empty";
	$: bar2 = pct >= 0.7 ? "yellow" : "empty";
	$: bar3 = pct >= 1.0 ? "red" : "empty";

	// When at capacity, all bars turn red
	$: bars = pct >= 1.0
		? ["red", "red", "red"]
		: [bar1, bar2, bar3];

	// Overall level for the progress bar in popover
	$: level = pct >= 1.0 ? "red" : pct >= 0.7 ? "yellow" : "green";

	let popoverStyle = "";

	$: if (isVisible && containerEl && popoverEl) {
		const rect = containerEl.getBoundingClientRect();
		const popRect = popoverEl.getBoundingClientRect();
		const fitsBelow = rect.bottom + popRect.height + 8 <= window.innerHeight;
		position = fitsBelow ? "below" : "above";
		const left = Math.max(8, rect.left + rect.width / 2 - popRect.width / 2);
		const top = fitsBelow
			? rect.bottom + 6
			: rect.top - popRect.height - 6;
		popoverStyle = `left: ${left}px; top: ${top}px;`;
	}

	function show() {
		isVisible = true;
	}
	function hide() {
		isVisible = false;
	}
</script>

<div
	class="meter-container"
	bind:this={containerEl}
	on:mouseenter={show}
	on:mouseleave={hide}
	role="img"
	aria-hidden="true"
>
	<div class="bars">
		{#each bars as color}
			<div class="bar {color === 'empty' ? 'empty' : 'filled ' + color}" />
		{/each}
	</div>

	{#if isVisible}
		<div
			bind:this={popoverEl}
			class="popover"
			style={popoverStyle}
		>
			<div class="arrow" class:above={position === "above"} class:below={position === "below"} style={position === "above" ? "bottom: -5px;" : "top: -5px;"} />
			<h4 class="popover-title">{label}</h4>
			<div class="popover-row">
				<span class="popover-label">
					{itemLabel}
					{#if helpText}
						<span class="help-icon" title={helpText}>i</span>
					{/if}
				</span>
				<span class="popover-value">{used}/{total}</span>
			</div>
			<div class="progress-track">
				<div class="progress-fill {level}" style="width: {percent}%;" />
			</div>
			{#if pending > 0}
				<div class="popover-row pending-row">
					<span class="popover-label">Queued</span>
					<span class="popover-value">{pending}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.meter-container {
		position: relative;
		display: inline-flex;
		align-items: center;
		padding: 4px;
		cursor: default;
	}

	.bars {
		display: flex;
		align-items: flex-end;
		gap: 2px;
	}

	.bar {
		width: 4px;
		height: 12px;
		border-radius: 2px;
		transition: background-color 0.2s ease;
	}

	.bar.filled.green {
		background-color: var(--color-green);
	}

	.bar.filled.yellow {
		background-color: var(--color-yellow);
	}

	.bar.filled.red {
		background-color: var(--color-red);
	}

	.bar.empty {
		background-color: var(--background-modifier-border);
	}

	/* Popover */
	.popover {
		position: fixed;
		z-index: var(--layer-popover);
		width: 180px;
		padding: 10px 12px;
		font-size: var(--font-ui-small);
		background-color: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-m);
		box-shadow: var(--shadow-s);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.arrow {
		position: absolute;
		width: 8px;
		height: 8px;
		left: 50%;
		margin-left: -4px;
		background-color: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		transform: rotate(45deg);
	}

	.arrow.below {
		top: -5px;
		border-right: none;
		border-bottom: none;
	}

	.arrow.above {
		bottom: -5px;
		border-left: none;
		border-top: none;
	}

	.popover-title {
		margin: 0;
		font-size: var(--font-ui-smaller);
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.popover-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.popover-label {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: var(--font-ui-smaller);
		color: var(--text-muted);
	}

	.popover-value {
		font-size: var(--font-ui-smaller);
		font-weight: 500;
		color: var(--text-normal);
	}

	.help-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		font-size: 10px;
		font-style: normal;
		font-weight: 600;
		color: var(--text-faint);
		background-color: var(--background-modifier-hover);
		border-radius: 50%;
		cursor: help;
	}

	.progress-track {
		width: 100%;
		height: 6px;
		background-color: var(--background-modifier-border);
		border-radius: 3px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s ease;
	}

	.progress-fill.green {
		background-color: var(--color-green);
	}

	.progress-fill.yellow {
		background-color: var(--color-yellow);
	}

	.progress-fill.red {
		background-color: var(--color-red);
	}
</style>
