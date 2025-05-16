<script>
	// The disk usage percentage prop is expected to be a number between 0 and 100.
	export let diskUsagePercentage = 0;
	export let text = "";
	diskUsagePercentage = Math.max(0.0, diskUsagePercentage);
	diskUsagePercentage = Math.min(100.0, diskUsagePercentage);
</script>

<div class="system3-disk-usage-container">
	<div
		class="system3-disk-usage-bar"
		style="width: {diskUsagePercentage}%;"
		data-state={diskUsagePercentage > 90.0 ? "warning" : ""}
	></div>
</div>
<div class="system3-disk-usage-report">{text}</div>

<style>
	.system3-disk-usage-container {
		width: 100%;
		background-color: var(--interactive-normal);
		overflow: hidden;
	}

	.system3-disk-usage-bar {
		height: 0.5rem;
		background-color: var(--color-accent);
		transition: width 0.6s ease;
	}

	.system3-disk-usage-report {
		text-align: center;
	}

	.system3-disk-usage-bar[data-state="warning"] {
		height: 0.3rem;
		background-color: var(--red);
		transition: width 0.6s ease;
	}
</style>
