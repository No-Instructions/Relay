<script lang="ts">
	import RelayText from "./RelayText.svelte";
</script>

<RelayText size={140} />
<p class="subtitle">Real-time collaboration in Obsidian</p>
<p class="description">
	Share folders with your team, edit together in real time, and keep your
	knowledge library exactly how you want it.
</p>

<style>
	.subtitle {
		color: var(--text-muted);
		font-size: 1.25rem;
		margin: 0;
	}
	.description {
		color: var(--text-muted);
		font-size: 1rem;
		max-width: 480px;
		margin: 0;
	}
</style>
