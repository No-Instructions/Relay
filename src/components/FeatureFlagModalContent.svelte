<script lang="ts">
	import { Notice } from "obsidian";
	import { FeatureFlagManager } from "../flagManager";
	import { isKeyOfFeatureFlags, type FeatureFlags } from "../flags";

	export let close: () => void;

	const flagManager = FeatureFlagManager.getInstance();
	let hasChanges = false;
	$: settings = { ...$flagManager.flags };

	function toggleFlag(flagName: keyof FeatureFlags) {
		const flagValue = !settings[flagName];
		settings[flagName] = flagValue;
		flagManager.setFlag(flagName, settings[flagName]);
		hasChanges = true;
	}

	function finish() {
		if (hasChanges) {
			new Notice("Reload the Relay plugin to apply feature flag changes.", 8000);
		}
		close();
	}
</script>

<div class="feature-flag-toggle-modal">
	<h2>Feature Flags</h2>
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

	<div class="modal-button-container relay-feature-flag-footer">
		{#if hasChanges}
			<span class="relay-feature-flag-reload-note">
				Reload the Relay plugin to apply changes.
			</span>
		{/if}
		<button class="mod-cta" on:click={finish}>Done</button>
	</div>
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

	.relay-feature-flag-footer {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: var(--size-4-2);
		padding-top: var(--size-4-3);
		margin-top: var(--size-4-3);
	}

	.relay-feature-flag-reload-note {
		color: var(--text-muted);
		font-size: var(--font-ui-smaller);
	}

	.checkbox-container {
		cursor: pointer;
	}
</style>
