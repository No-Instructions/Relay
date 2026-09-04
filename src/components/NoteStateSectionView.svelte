<script lang="ts">
	import type { Readable } from "svelte/store";
	import type { NoteStateViewModel } from "../ui/NoteStateSection";

	export let viewModel: Readable<NoteStateViewModel>;
</script>

<div class="system3-note-state-header">
	<div class="system3-note-state-title">{$viewModel.title}</div>
	<div class="system3-note-state-pill system3-note-state-{$viewModel.verdict.cls}">
		{$viewModel.verdict.label}
	</div>
</div>

{#each $viewModel.rows as row (row.label)}
	<div class="system3-note-state-row">
		<span class="system3-note-state-label">{row.label}</span>
		<span
			class:system3-note-state-ok={row.cls === "ok"}
			class:system3-note-state-warn={row.cls === "warn"}
			class:system3-note-state-bad={row.cls === "bad"}
			class:system3-note-state-muted={row.cls === "muted"}
			class:system3-note-state-mono={row.mono}
			class="system3-note-state-value"
		>
			{row.value}
		</span>
	</div>
{/each}
