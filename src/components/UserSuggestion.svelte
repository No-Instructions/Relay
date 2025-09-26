<script lang="ts">
	import type { RelayUser } from "src/Relay";

	interface UserSuggestion {
		user: RelayUser;
		hasAccess: boolean;
	}

	export let suggestion: UserSuggestion;
</script>

<div class="suggestion-content">
	<div class="suggestion-title">
		{suggestion.user.name}
		{#if suggestion.hasAccess}
			<span class="suggestion-note">(Already has access)</span>
		{/if}
	</div>
</div>

<style>
	.suggestion-content {
		padding: 4px 0;
	}

	.suggestion-title {
		font-weight: 500;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.suggestion-note {
		font-size: 0.85em;
		color: var(--text-muted);
		font-weight: normal;
	}
</style>