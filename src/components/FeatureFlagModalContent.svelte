<script lang="ts">
	import { setIcon, type IconName } from "obsidian";
	import { isDebugging } from "../debug";
	import { FeatureFlagManager } from "../flagManager";
	import {
		FeatureFlagSchema,
		type FeatureFlagCategory,
		type FeatureFlags,
	} from "../flags";
	import SettingGroup from "./SettingGroup.svelte";

	export let reload: () => void;

	type Tab = {
		id: FeatureFlagCategory;
		label: string;
		icon: IconName;
		flags: (keyof FeatureFlags)[];
	};

	const tabInfo: Record<
		FeatureFlagCategory,
		{ label: string; icon: IconName }
	> = {
		labs: { label: "Labs", icon: "flask-conical" },
		debugging: { label: "Debugging", icon: "bug" },
		danger: { label: "Danger zone", icon: "triangle-alert" },
	};

	const flagManager = FeatureFlagManager.getInstance();
	const debugging = isDebugging();
	let activeTab: FeatureFlagCategory = "labs";

	$: settings = { ...$flagManager.flags };
	$: tabs = (Object.keys(tabInfo) as FeatureFlagCategory[])
		.map((category) => ({
			id: category,
			...tabInfo[category],
			flags: flagsForCategory(category),
		}))
		.filter((tab) => tab.flags.length > 0 && (debugging || tab.id === "labs"));
	$: if (tabs.length > 0 && !tabs.some((tab) => tab.id === activeTab)) {
		activeTab = tabs[0].id;
	}
	$: selectedTab = tabs.find((tab) => tab.id === activeTab);

	function flagsForCategory(category: FeatureFlagCategory) {
		return (Object.keys(FeatureFlagSchema) as (keyof FeatureFlags)[]).filter(
			(flagName) => FeatureFlagSchema[flagName].category === category,
		);
	}

	function toggleFlag(flagName: keyof FeatureFlags) {
		const next = !(settings[flagName] ?? FeatureFlagSchema[flagName].default);
		flagManager.setFlag(flagName, next);
	}

	function handleToggleKey(event: KeyboardEvent, flagName: keyof FeatureFlags) {
		if (event.key !== "Enter" && event.key !== " ") return;

		event.preventDefault();
		toggleFlag(flagName);
	}

	function icon(node: HTMLElement, iconName: IconName) {
		setIcon(node, iconName);

		return {
			update(nextIconName: IconName) {
				node.replaceChildren();
				setIcon(node, nextIconName);
			},
		};
	}
</script>

<div class="relay-feature-flag-modal-content">
	<div class="relay-feature-flag-tabs" role="tablist" aria-label="Feature flag category">
		{#each tabs as tab}
			<button
				type="button"
				role="tab"
				aria-selected={activeTab === tab.id}
				class="relay-feature-flag-tab"
				class:relay-feature-flag-danger-tab={tab.id === "danger"}
				on:click={() => (activeTab = tab.id)}
			>
				<span
					class="relay-feature-flag-tab-icon"
					aria-hidden="true"
					use:icon={tab.icon}
				/>
				<span>{tab.label}</span>
			</button>
		{/each}
	</div>

	<div class="relay-feature-flag-panel" role="tabpanel">
		{#if selectedTab}
			<div
				class="relay-feature-flag-group"
				class:relay-feature-flag-danger-group={selectedTab.id === "danger"}
			>
				<SettingGroup>
					{#each selectedTab.flags as flagName}
						{@const entry = FeatureFlagSchema[flagName]}
						{@const value = settings[flagName] ?? entry.default}
						<div
							class="setting-item"
							class:relay-feature-flag-danger-setting={selectedTab.id === "danger"}
						>
							<div class="setting-item-info">
								<div class="setting-item-name">
									<span class="relay-feature-flag-title-line">
										<span>{entry.title}</span>
										<code class="relay-feature-flag-key">{flagName}</code>
									</span>
								</div>
								<div class="setting-item-description">
									<div>{entry.description}</div>
								</div>
							</div>
							<div class="setting-item-control">
								<div
									role="switch"
									aria-checked={value}
									tabindex="0"
									class="checkbox-container"
									class:is-enabled={value}
									on:click={() => toggleFlag(flagName)}
									on:keydown={(event) => handleToggleKey(event, flagName)}
								>
									<input type="checkbox" tabindex="-1" checked={value} />
									<div class="checkbox-toggle" />
								</div>
							</div>
						</div>
					{/each}
				</SettingGroup>
			</div>
		{/if}
	</div>

	<div class="modal-button-container relay-feature-flag-footer">
		<button class="mod-cta" on:click={reload}>Apply</button>
	</div>
</div>

<style>
	.relay-feature-flag-modal-content {
		display: flex;
		flex-direction: column;
		max-height: var(--modal-max-height);
		min-height: 0;
	}

	.relay-feature-flag-tabs {
		display: flex;
		flex: 0 0 auto;
		gap: var(--size-2-1);
		border-bottom: var(--border-width) solid var(--background-modifier-border);
		margin-bottom: var(--size-4-3);
	}

	.relay-feature-flag-tab {
		display: inline-flex;
		align-items: center;
		gap: var(--size-2-2);
		color: var(--text-muted);
		background: transparent;
		box-shadow: none;
		border: 0;
		border-radius: 0;
		padding: var(--size-2-3) var(--size-4-2);
	}

	.relay-feature-flag-tab:hover,
	.relay-feature-flag-tab[aria-selected="true"] {
		color: var(--text-normal);
		box-shadow: none;
	}

	.relay-feature-flag-tab[aria-selected="true"] {
		box-shadow: inset 0 calc(-1 * var(--border-width)) 0
			var(--interactive-accent);
	}

	.relay-feature-flag-tab.relay-feature-flag-danger-tab {
		color: var(--text-error);
	}

	.relay-feature-flag-tab.relay-feature-flag-danger-tab[aria-selected="true"] {
		box-shadow: inset 0 calc(-1 * var(--border-width)) 0 var(--text-error);
	}

	.relay-feature-flag-tab-icon {
		display: inline-flex;
	}

	.relay-feature-flag-panel {
		flex: 1 1 auto;
		overflow: hidden;
		min-height: 0;
	}

	.relay-feature-flag-group {
		--relay-feature-flag-group-height: min(50vh, var(--modal-max-height));

		min-height: var(--relay-feature-flag-group-height);
		max-height: var(--relay-feature-flag-group-height);
		overflow-y: auto;
	}

	.relay-feature-flag-title-line {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--size-2-2);
	}

	.relay-feature-flag-key {
		color: var(--text-faint);
		background: transparent;
		font-size: var(--font-ui-smaller);
		font-family: var(--font-monospace);
		user-select: text;
		-webkit-user-select: text;
		cursor: text;
	}

	.relay-feature-flag-danger-setting {
		background: var(--background-modifier-error);
	}

	.relay-feature-flag-danger-setting .setting-item-name {
		color: var(--text-error);
	}

	.relay-feature-flag-footer {
		display: flex;
		flex: 0 0 auto;
		justify-content: flex-end;
		padding-top: var(--size-4-3);
		margin-top: var(--size-4-3);
	}

	.checkbox-container {
		cursor: pointer;
	}
</style>
