<script lang="ts">
	import { FeatureFlagManager, flags } from "../flagManager";
	import { isKeyOfFeatureFlags, type FeatureFlags } from "../flags";
	import { setIcon } from "obsidian";
	import { onMount } from "svelte";

	export let reload: () => void;

	let flagManager = FeatureFlagManager.getInstance();
	$: settings = { ...$flagManager.flags };

	function toggleFlag(flagName: keyof FeatureFlags) {
		const flagValue = !settings[flagName];
		settings[flagName] = flagValue;
		flagManager.setFlag(flagName as keyof FeatureFlags, settings[flagName]);
	}

	onMount(() => {
		Object.keys(settings).forEach((flagName) => {
			const toggleEl = document.getElementById(`toggle-${flagName}`);
			if (toggleEl) {
				setIcon(toggleEl, "check");
			}
		});
	});
</script>

<div class="feature-flag-toggle-modal">
	<h2>Feature Flags</h2>
	<div class="feature-flag-list">
		{#each Object.entries(settings)
			.filter(([k, v]) => isKeyOfFeatureFlags(k))
			.sort() as [flagName, value]}
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
							if (!isKeyOfFeatureFlags(flagName))
								throw new Error("Unexpected feature flag!");
							toggleFlag(flagName);
						}}
						class="checkbox-container"
						class:is-enabled={value}
						on:click={() => {
							if (!isKeyOfFeatureFlags(flagName))
								throw new Error("Unexpected feature flag!");
							toggleFlag(flagName);
						}}
					>
						<input type="checkbox" tabindex="-1" checked={value} />
						<div class="checkbox-toggle"></div>
					</div>
				</div>
			</div>
		{/each}
	</div>

	<div class="feature-flag-footer">
		<button
			aria-label="apply flag settings"
			on:click={reload}
			on:keypress={reload}
			tabindex="0"
		>
			Apply
		</button>
	</div>
</div>

<style>
	.feature-flag-toggle-modal {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		max-height: 70vh;
	}
	.feature-flag-list {
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}
	.feature-flag-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 0;
		border-top: 1px solid var(--background-modifier-border);
	}
	.feature-flag-footer {
		padding-top: 1rem;
		border-top: 1px solid var(--background-modifier-border);
		display: flex;
		justify-content: flex-end;
		flex-shrink: 0;
	}
	.checkbox-container {
		cursor: pointer;
	}
</style>
