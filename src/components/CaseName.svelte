<script lang="ts">
	import { caseDiff } from "src/caseConflictState";

	/** A name with the characters that differ from the other spelling marked. */
	export let name: string;
	export let against: string;

	$: runs = caseDiff(name, against);
</script>

<span class="relay-case-name"
	>{#each runs as run}{#if run.differs}<mark class="relay-case-diff">{run.text}</mark
			>{:else}{run.text}{/if}{/each}</span
>
