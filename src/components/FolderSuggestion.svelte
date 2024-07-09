<script lang="ts">
	import { Folder, Layers } from "lucide-svelte";

	interface Suggestion {
		folder: string;
		exists: boolean;
		shared: boolean;
	}

	export let suggestion: Suggestion;
</script>

<div class="suggestion-content">
	<div class="suggestion-title">
		{suggestion.folder}
	</div>
</div>
<div class="suggestion-aux">
	{#if !suggestion.exists}
		<span class="suggestion-action">Enter to create</span>
	{:else}
		<div class="suggestion-icon">
			{#if suggestion.shared}
				<Layers class="svg-icon" />
			{/if}
		</div>
	{/if}
</div>
