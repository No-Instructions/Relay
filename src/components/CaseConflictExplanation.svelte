<script lang="ts">
	// The content of the "more info" modal: both spellings with the letters
	// that differ marked and where each one is, then why, and the fix. The
	// modal around it supplies the title and the rename buttons.
	import CaseName from "./CaseName.svelte";
	import type { CaseConflictExplanation } from "src/caseConflictState";

	export let explanation: CaseConflictExplanation;
</script>

<div class="relay-case-conflict-info">
	<div class="relay-case-conflict-names">
		{#each explanation.rows as row (row.path)}
			<div class="relay-case-conflict-row">
				<CaseName name={row.name} against={row.against} />
				<span class="relay-case-conflict-status"
					>{row.status}{#if row.containsThis}{" · Contains this note"}{/if}</span
				>
			</div>
		{/each}
	</div>
	<p class="relay-case-conflict-body">{explanation.body}</p>
	<p class="relay-case-conflict-fix">{explanation.fix}</p>
	<a class="relay-case-conflict-docs" href={explanation.docs.url} target="_blank" rel="noopener">
		{explanation.docs.label}
	</a>
</div>
