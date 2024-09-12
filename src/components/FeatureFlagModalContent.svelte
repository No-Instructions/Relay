<script lang="ts">
	import { FeatureFlagManager } from "../flagManager";
	import type { FeatureFlags } from "../flags";
	import { setIcon } from "obsidian";
	import { onMount } from "svelte";

	let flagManager = FeatureFlagManager.getInstance();
	let flags: FeatureFlags = { ...flagManager.flags };

	function toggleFlag(flagName: string) {
		flags[flagName] = !flags[flagName];
		flagManager.setFlag(flagName as keyof FeatureFlags, flags[flagName], true);
	}

	onMount(() => {
		Object.keys(flags).forEach((flagName) => {
			const toggleEl = document.getElementById(`toggle-${flagName}`);
			if (toggleEl) {
				setIcon(toggleEl, "check");
			}
		});
	});
</script>

<div class="feature-flag-toggle-modal">
	<h2>Feature Flags</h2>
	<p>Make sure you reload obsidian after changing the flags below.</p>
	{#each Object.entries(flags) as [flagName, value]}
		<div class="feature-flag-item setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">{flagName}</div>
				<div class="setting-item-description">Toggle {flagName} on or off</div>
			</div>
			<div class="setting-item-control">
				<div
					role="checkbox"
					aria-checked={value}
					tabindex="0"
					on:keypress={() => {
						toggleFlag(flagName);
					}}
					class="checkbox-container"
					class:is-enabled={value}
					on:click={() => toggleFlag(flagName)}
				>
					<input type="checkbox" checked={value} />
					<div class="checkbox-toggle"></div>
				</div>
			</div>
		</div>
	{/each}
</div>

<style>
	.feature-flag-toggle-modal {
		padding: 1rem;
	}
	.feature-flag-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 0;
		border-top: 1px solid var(--background-modifier-border);
	}
	.checkbox-container {
		cursor: pointer;
	}
</style>
