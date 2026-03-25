<script lang="ts">
	/**
	 * A compact resource usage indicator with hover popover.
	 *
	 * Displays colored bars representing slot utilization across multiple folders.
	 * The bars reflect the highest-utilization folder:
	 *   - green: plenty of headroom
	 *   - yellow: mostly used
	 *   - red: maxed out
	 *   - empty slots: gray
	 *
	 * On hover, a popover shows per-folder progress bars with usage details.
	 */

	export interface FolderStats {
		name: string;
		used: number;
		pending: number;
		total: number;
	}

	export let label = "Wake Queue";
	export let folders: FolderStats[] = [];

	let isVisible = false;
	let containerEl: HTMLDivElement;
	let popoverEl: HTMLDivElement;
	let position: "above" | "below" = "below";

	// Derive bars from the worst-case folder utilization
	$: worstPct = folders.reduce((max, f) => {
		const p = f.total > 0 ? f.used / f.total : 0;
		return p > max ? p : max;
	}, 0);

	$: bar1 = worstPct >= 0.3 ? "green" : "empty";
	$: bar2 = worstPct >= 0.7 ? "yellow" : "empty";
	$: bar3 = worstPct >= 1.0 ? "red" : "empty";

	$: bars = worstPct >= 1.0
		? ["red", "red", "red"]
		: [bar1, bar2, bar3];

	function levelFor(f: FolderStats): string {
		const p = f.total > 0 ? f.used / f.total : 0;
		return p >= 1.0 ? "red" : p >= 0.7 ? "yellow" : "green";
	}

	function percentFor(f: FolderStats): number {
		return f.total > 0 ? Math.round((f.used / f.total) * 100) : 0;
	}

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
			{#each folders as f}
				<div class="folder-section">
					<div class="popover-row">
						<span class="popover-label">{f.name}</span>
						<span class="popover-value">{f.used}/{f.total}</span>
					</div>
					<div class="progress-track">
						<div class="progress-fill {levelFor(f)}" style="width: {percentFor(f)}%;" />
					</div>
					{#if f.pending > 0}
						<div class="popover-row pending-row">
							<span class="popover-label">Queued</span>
							<span class="popover-value">{f.pending}</span>
						</div>
					{/if}
				</div>
			{/each}
			{#if folders.length === 0}
				<div class="popover-row">
					<span class="popover-label empty-label">No shared folders</span>
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
		width: 200px;
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

	.folder-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
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
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.empty-label {
		font-style: italic;
	}

	.popover-value {
		font-size: var(--font-ui-smaller);
		font-weight: 500;
		color: var(--text-normal);
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
