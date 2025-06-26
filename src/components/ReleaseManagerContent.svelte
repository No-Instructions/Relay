<script lang="ts">
	import { MarkdownRenderer } from "obsidian";
	import { derived, writable } from "svelte/store";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import type Live from "../main";
	import { flags } from "../flagManager";
	import { onMount } from "svelte";
	import type { Release, WithPlugins } from "src/UpdateManager";

	export let plugin: Live;
	export let version: string | undefined;

	const currentVersion = writable<string>(plugin.manifest.version);
	const updateAvailable = writable<boolean>(false);
	const newVersion = writable<string>("");
	const repository = writable<string>("");

	// Store for GitHub releases - we'll access cached releases directly from UpdateManager
	const loadingReleases = writable<boolean>(false);
	const showAllReleases = writable<boolean>(false);

	// Manifest viewing
	const selectedManifest = writable<any | null>(null);
	const selectedManifestTag = writable<string>("");
	const loadingManifest = writable<string | null>(null);
	const manifestError = writable<string | null>(null);
	const showManifest = writable<boolean>(false);

	// Main branch manifests
	const stableManifest = writable<any | null>(null);
	const betaManifest = writable<any | null>(null);
	const stableVersion = writable<string | null>(null);
	const betaVersion = writable<string | null>(null);
	const loadingMainBranchManifests = writable<boolean>(false);

	// Installation status
	let installingUpdate = false;
	const installingVersion = writable<string | null>(null);

	// Keep a reference to the app for plugin installation
	// This is important as the plugin instance may be unloaded during update
	const app = plugin.app as unknown as WithPlugins;
	const pluginId = "system3-relay";

	// No need for unsubscriber with reactive bindings

	// Helper functions to handle version comparisons
	function normalizeVersion(version: string): string {
		// Remove leading 'v' if present
		return version.startsWith("v") ? version.substring(1) : version;
	}

	// Check if a tag represents the current Git tag
	function isCurrentVersion(tagName: string): boolean {
		const normalizedTag = normalizeVersion(tagName);
		const normalizedGitTag = normalizeVersion(plugin.version);
		return normalizedTag === normalizedGitTag;
	}

	// Check if a release is a prerelease
	function isPrerelease(release: any): boolean {
		return release?.prerelease === true;
	}
	// Store for tracking manifest versions
	const manifestVersions = writable<Record<string, string>>({});
	const releaseChannels = writable<Record<string, string>>({});

	// Store for active channel (beta, stable, development or null)
	const activeChannel = writable<"beta" | "stable" | null>(
		plugin.releaseSettings.get().channel,
	);

	onMount(() => {
		// Initial setup - check GitHub releases immediately
		refreshGithubReleases();

		// Fetch main branch manifests (stable and beta)
		fetchMainBranchManifests();

		// Immediately select the development version (current version)
		// Set development as the active channel
		if (
			!version &&
			!$githubReleases.some((release) => {
				release.tag_name === plugin.version;
			})
		) {
			activeChannel.set(null);
		} else {
			activeChannel.set(plugin.releaseSettings.get().channel);
		}
		selectedManifest.set({
			version: version || plugin.version,
			name: plugin.manifest.name,
			author: plugin.manifest.author,
			description: plugin.manifest.description,
			isDesktopOnly: plugin.manifest.isDesktopOnly,
			minAppVersion: plugin.manifest.minAppVersion,
		});
		selectedManifestTag.set(version || plugin.version);
	});

	// Function to fetch main branch manifests (stable and beta)
	async function fetchMainBranchManifests() {
		loadingMainBranchManifests.set(true);
		try {
			const manifest =
				await plugin.updateManager.fetchRepoManifest("manifest.json");
			if (manifest) {
				stableManifest.set(manifest);
				stableVersion.set(manifest.version);
			}
			const manifestBeta =
				await plugin.updateManager.fetchRepoManifest("manifest-beta.json");
			if (manifestBeta) {
				betaManifest.set(manifestBeta);
				betaVersion.set(manifestBeta.version);
			}
		} catch (error) {
			plugin.error("Error fetching main branch manifests:", error);
		} finally {
			loadingMainBranchManifests.set(false);
		}
	}

	// Access GitHub releases directly from the UpdateManager
	const githubReleases = derived(plugin.updateManager, () => {
		return plugin.updateManager.releases;
	});

	// Update filtered releases when githubReleases changes or when toggle changes
	const filteredReleases = derived([githubReleases, showAllReleases], () => {
		if ($githubReleases && $githubReleases.length > 0) {
			return filterReleases($showAllReleases).sort();
		} else {
			return [];
		}
	});

	// When releases change, fetch their manifests to check for version mismatches
	// Pre-fetch manifests for all releases to check for mismatches
	$githubReleases.forEach(async (release: Release) => {
		try {
			const manifest = await plugin.updateManager.fetchReleaseManifest(release);
			if (manifest) {
				manifestVersions.update((versions) => ({
					...versions,
					[release.tag_name]: manifest.version,
				}));
			}
		} catch (e) {
			// Just continue if we can't fetch a manifest
		}
	});

	// Refresh releases (forces a new fetch if needed)
	async function refreshGithubReleases() {
		loadingReleases.set(true);
		try {
			await plugin.updateManager.getReleases();
			filterReleases($showAllReleases);
		} catch (error) {
			plugin.error("Error refreshing GitHub releases:", error);
		} finally {
			loadingReleases.set(false);
		}
	}

	async function render(md: string): Promise<string> {
		const el = document.createElement("div");
		await MarkdownRenderer.render(plugin.app, md, el, "", plugin);
		return el.innerHTML;
	}

	// Filter releases based on show all toggle
	function filterReleases(showAll: boolean): Release[] {
		if (showAll) {
			// Show all releases
			return $githubReleases;
		} else if (version) {
			return $githubReleases.filter((release) => {
				return version === normalizeVersion(release.tag_name);
			});
		} else {
			return $githubReleases.filter((release) => {
				const tagName = release.tag_name;
				return isRecentPublicRelease(release);
			});
		}
	}

	function isRecentPublicRelease(release: Release): boolean {
		if (release.prerelease || release.draft) return false;
		if (release.latest) return true;
		if (normalizeVersion(release.tag_name) === $stableVersion) return true;
		if (normalizeVersion(release.tag_name) === $betaVersion) return true;
		const createdAt = new Date(release.created_at);
		const threeMonthsAgo = new Date();
		threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
		return createdAt > threeMonthsAgo;
	}

	// Function to fetch and view release details for a specific release
	async function viewReleaseManifest(tagName: string) {
		// Reset any previous errors
		manifestError.set(null);

		// Set loading state for this specific tag
		loadingManifest.set(tagName);

		try {
			const release = findReleaseByTag(tagName);
			if (!release) {
				manifestError.set(`Could not find release for ${tagName}`);
				return;
			}

			const manifest = await plugin.updateManager.fetchReleaseManifest(release);

			if (manifest) {
				selectedManifest.set(manifest);
				selectedManifestTag.set(tagName);
				showManifest.set(false); // Hide manifest by default

				// Also update the manifest versions cache
				manifestVersions.update((versions) => ({
					...versions,
					[tagName]: manifest.version,
				}));
			} else {
				manifestError.set(`Could not find manifest for ${tagName}`);
			}
		} catch (error) {
			plugin.error("Error fetching manifest:", error);
			manifestError.set(
				`Error fetching manifest: ${(error as Error).message || "Unknown error"}`,
			);
		} finally {
			loadingManifest.set(null);
		}
	}

	// Function to view stable or beta manifest - find and show the matching GitHub release
	function viewMainBranchManifest(type: "stable" | "beta") {
		const manifest = type === "stable" ? $stableManifest : $betaManifest;
		if (manifest) {
			// Find the matching GitHub release with the same version
			const version = manifest.version;

			// Set active channel to highlight the correct button
			activeChannel.set(type);

			// First check if we have a matching tag directly
			const releaseWithExactTag = [...$githubReleases.values()].find(
				(r) => normalizeVersion(r.tag_name) === normalizeVersion(version),
			);

			if (releaseWithExactTag) {
				// We found an exact match, use viewReleaseManifest to show standard release details
				// But we'll set an alias flag first so we know where it came from
				if (type === "stable") {
					releaseChannels.update((v) => ({
						...v,
						[releaseWithExactTag.tag_name]: "stable-alias",
					}));
				} else {
					releaseChannels.update((v) => ({
						...v,
						[releaseWithExactTag.tag_name]: "beta-alias",
					}));
				}
				viewReleaseManifest(releaseWithExactTag.tag_name);
			} else {
				// No exact match, use the manifest directly but set an alias flag
				selectedManifest.set(manifest);
				selectedManifestTag.set(version);
				// Store which alias this is for badge display
				if (type === "stable") {
					releaseChannels.update((v) => ({ ...v, [version]: "stable-alias" }));
				} else {
					releaseChannels.update((v) => ({ ...v, [version]: "beta-alias" }));
				}
				showManifest.set(false);
			}
		} else {
			manifestError.set(`Could not find ${type} manifest`);
		}
	}

	// Reset manifest view
	function closeManifestView() {
		selectedManifest.set(null);
		selectedManifestTag.set("");
		manifestError.set(null);
	}

	// Find a GitHub release by tag
	function findReleaseByTag(tagName: string) {
		return [...$githubReleases.values()].find((r) => r.tag_name === tagName);
	}

	// Function to install a specific version from GitHub release
	async function installSpecificVersion(tagName: string) {
		try {
			// Set installing state for this specific version
			installingVersion.set(tagName);

			// Find the release
			const release = findReleaseByTag(tagName);
			if (!release) {
				throw new Error(`Could not find release for ${tagName}`);
			}

			// Fetch manifest from release assets
			const manifest = await plugin.updateManager.fetchReleaseManifest(release);
			if (!manifest) {
				throw new Error(`Could not find manifest for ${tagName}`);
			}

			// Show installing status
			installingUpdate = true;

			// Use the cached app reference instead of plugin.app which might become null
			await app.plugins.installPlugin(plugin.repo, tagName, manifest);

			// Reload the plugin after installation
			await app.plugins.disablePlugin(pluginId);
			await app.plugins.enablePlugin(pluginId);
		} catch (error) {
			// Use console.error as a fallback since plugin.error might not be available
			console.error(`Error installing version ${tagName}:`, error);
			if (plugin) {
				plugin.error(`Error installing version ${tagName}:`, error);
			}
		} finally {
			if (plugin) {
				installingUpdate = false;
				installingVersion.set(null);
			}
		}
	}
</script>

<div class="modal-title">{version ? "Relay installer" : "Relay releases"}</div>
<div class="modal-content">
	<div class="settings-spacer"></div>

	<div class="settings-container">
		{#if !version}
			<SlimSettingItem name="Show all releases">
				<div
					class="checkbox-container"
					class:is-enabled={$showAllReleases}
					role="checkbox"
					aria-checked={$showAllReleases}
					tabindex="0"
					on:click={() => {
						showAllReleases.update((v) => !v);
					}}
					on:keydown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							showAllReleases.update((v) => !v);
						}
					}}
				>
					<input type="checkbox" checked={$showAllReleases} />
					<div class="checkbox-toggle"></div>
				</div>
			</SlimSettingItem>
		{/if}
	</div>

	{#if $loadingReleases}
		<div class="loading-text">Loading GitHub releases...</div>
	{:else if $githubReleases.length === 0}
		<div class="no-releases-text">No GitHub releases found</div>
	{:else if $filteredReleases.length === 0}
		<div class="no-releases-text">
			No matching releases found with the current filter
		</div>
	{:else}
		<!-- Compact tag list at the top -->
		{#if !version }
			<div class="release-tags-container">
				<!-- Beta and Stable alias tags -->

				{#if $stableManifest}
					<div
						class="release-tag-item main-branch-version stable-version"
						role="tab"
						aria-selected={$activeChannel === "stable"}
						tabindex="0"
						on:click={() => {
							plugin.releaseSettings.update((release) => {
								return {
									...release,
									channel: "stable",
								};
							});
							activeChannel.set("stable");
							viewMainBranchManifest("stable");
						}}
						on:keydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								plugin.releaseSettings.update((release) => {
									return {
										...release,
										channel: "stable",
									};
								});
								activeChannel.set("stable");
								viewMainBranchManifest("stable");
							}
						}}
					>
						<div class="tag-name">Stable</div>
					</div>
				{/if}

				{#if $betaManifest}
					<div
						class="release-tag-item main-branch-version beta-version"
						role="tab"
						aria-selected={$activeChannel === "beta"}
						tabindex="0"
						on:click={() => {
							plugin.releaseSettings.update((release) => {
								return {
									...release,
									channel: "beta",
								};
							});
							activeChannel.set("beta");
							viewMainBranchManifest("beta");
						}}
						on:keydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								plugin.releaseSettings.update((release) => {
									return {
										...release,
										channel: "beta",
									};
								});
								activeChannel.set("beta");
								viewMainBranchManifest("beta");
							}
						}}
					>
						<div class="tag-name">Beta</div>
					</div>
				{/if}
				<!-- Development version tag if not already in filtered releases -->
				{#if !$filteredReleases.some((release) => {
						return isCurrentVersion(release.tag_name);
					})}
					<div
						class="release-tag-item development-version"
						role="tab"
						aria-selected={$selectedManifestTag === plugin.version}
						tabindex="0"
						on:click={() => {
							activeChannel.set(null);
							selectedManifest.set({
								version: plugin.manifest.version,
								name: plugin.manifest.name,
								author: plugin.manifest.author,
								description: plugin.manifest.description,
								isDesktopOnly: plugin.manifest.isDesktopOnly,
								minAppVersion: plugin.manifest.minAppVersion,
							});
							selectedManifestTag.set(plugin.version);
							showManifest.set(false);
						}}
						on:keydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								activeChannel.set(null);
								selectedManifest.set({
									version: plugin.manifest.version,
									name: plugin.manifest.name,
									author: plugin.manifest.author,
									description: plugin.manifest.description,
									isDesktopOnly: plugin.manifest.isDesktopOnly,
									minAppVersion: plugin.manifest.minAppVersion,
								});
								selectedManifestTag.set(plugin.version);
								showManifest.set(false);
							}
						}}
					>
						<div class="tag-name">Dev</div>
					</div>
				{/if}

				<!-- Release tags -->
				{#if !version}
					{#each $filteredReleases as release}
						<div
							class="release-tag-item {isCurrentVersion(release.tag_name)
								? 'current-version'
								: ''}
								{isPrerelease(release) ? 'pre-release' : ''}"
							role="tab"
							aria-selected={$selectedManifestTag === release.tag_name}
							tabindex="0"
							on:click={() => {
								activeChannel.set(null);
								viewReleaseManifest(release.tag_name);
							}}
							on:keydown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									activeChannel.set(null);
									viewReleaseManifest(release.tag_name);
								}
							}}
						>
							<div class="tag-name">
								{release.tag_name}
							</div>
						</div>
					{/each}
				{/if}
			</div>
		{/if}

		<!-- Detail panel -->
		{#if $selectedManifest}
			<div class="manifest-container">
				<div class="manifest-header">
					<h3>
						Release Details: {$selectedManifestTag}
						{#if findReleaseByTag($selectedManifestTag)?.prerelease}
							<span class="prerelease-badge">Pre-release</span>
						{/if}
						{#if $releaseChannels[$selectedManifestTag] === "beta-alias"}
							<span class="channel-badge beta-badge">Beta</span>
						{/if}
						{#if $releaseChannels[$selectedManifestTag] === "stable-alias"}
							<span class="channel-badge stable-badge">Stable</span>
						{/if}
					</h3>
					<div class="manifest-header-actions">
						{#if (findReleaseByTag($selectedManifestTag) || $manifestVersions[$selectedManifestTag] === "stable-alias" || $manifestVersions[$selectedManifestTag] === "beta-alias") && !isCurrentVersion($selectedManifestTag)}
							<button
								class="install-version-btn mod-cta"
								on:click={async () => {
									installSpecificVersion($selectedManifestTag);
								}}
								disabled={$installingVersion === $selectedManifestTag ||
									installingUpdate}
							>
								{#if $installingVersion === $selectedManifestTag}
									Installing...
								{:else}
									Install
								{/if}
							</button>
						{:else if isCurrentVersion($selectedManifestTag)}
							<span class="currently-installed">Installed</span>
						{/if}
					</div>
				</div>

				<!-- Show changelog first -->
				<div class="release-changelog">
					<div class="release-changelog-content">
						{#if $manifestVersions[$selectedManifestTag] === "stable-alias" || $manifestVersions[$selectedManifestTag] === "beta-alias" || $activeChannel === "development"}
							{#if $manifestVersions[$selectedManifestTag] === "stable-alias"}
								<p>Current stable release from main branch manifest.json</p>
							{:else if $manifestVersions[$selectedManifestTag] === "beta-alias"}
								<p>Current beta release from main branch manifest-beta.json</p>
							{:else if $selectedManifestTag === plugin.version}
								<p>Current development version</p>
							{/if}
						{:else if $selectedManifestTag}
							{#await render(findReleaseByTag($selectedManifestTag)?.body || "No changelog available")}
								"loading..."
							{:then renderedMarkdown}
								{@html renderedMarkdown}
							{/await}
						{:else}
							"No changelog available"
						{/if}
					</div>
				</div>

				{#if $showManifest}
					<div class="manifest-content">
						<div class="manifest-field">
							<span class="manifest-label">Version:</span>
							<span class="manifest-value">{$selectedManifest.version}</span>
							{#if $selectedManifestTag !== $selectedManifest.version && !$selectedManifestTag.startsWith("v" + $selectedManifest.version)}
								<span class="manifest-version-mismatch">
									<span class="manifest-version-mismatch-icon">⚠️</span>
									Version mismatch
								</span>
							{/if}
						</div>
						<div class="manifest-field">
							<span class="manifest-label">Name:</span>
							<span class="manifest-value">{$selectedManifest.name}</span>
						</div>
						<div class="manifest-field">
							<span class="manifest-label">Author:</span>
							<span class="manifest-value">{$selectedManifest.author}</span>
						</div>
						<div class="manifest-field">
							<span class="manifest-label">Description:</span>
							<span class="manifest-value">{$selectedManifest.description}</span
							>
						</div>
						<div class="manifest-field">
							<span class="manifest-label">isDesktopOnly:</span>
							<span class="manifest-value"
								>{$selectedManifest.isDesktopOnly ? "Yes" : "No"}</span
							>
						</div>
						<div class="manifest-field">
							<span class="manifest-label">minAppVersion:</span>
							<span class="manifest-value"
								>{$selectedManifest.minAppVersion}</span
							>
						</div>
					</div>
				{/if}
			</div>
		{:else if $manifestError}
			<div class="manifest-error">
				<div class="manifest-error-message">{$manifestError}</div>
				<button class="manifest-close-btn" on:click={closeManifestView}>
					Close
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	/* Basic padding on modal content */
	.modal-content {
		padding: 0;
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	/* Settings container */
	.settings-container {
		margin: 0 1rem;
		border-bottom: 1px solid var(--background-modifier-border);
		margin-bottom: 1rem;
	}

	/* Add space before the first settings item */
	.settings-spacer {
		height: 0.5rem;
	}

	/* We use Obsidian's default toggle styling */
	.checkbox-container {
		cursor: pointer;
	}

	.loading-text,
	.no-releases-text {
		padding: 12px;
		text-align: center;
		color: var(--text-muted);
		font-style: italic;
	}

	/* Release tags container */
	.release-tags-container {
		display: flex;
		flex-wrap: wrap;
		column-gap: 8px;
		row-gap: 4px;
		padding: 0 1rem 1rem;
		max-height: 160px;
		overflow-y: auto;
	}

	.release-tag-item {
		display: flex;
		justify-content: center;
		align-items: center;
		background-color: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		padding: 4px 8px;
		height: 24px;
		cursor: pointer;
		opacity: 0.7;
		position: relative;
	}

	.release-tag-item:hover {
		background-color: var(--background-modifier-hover);
		opacity: 0.9;
	}

	.release-tag-item[aria-selected="true"] {
		background-color: var(--color-accent);
		border-color: var(--background-modifier-border);
		border-bottom-width: 2px;
		opacity: 1;
	}

	.release-tag-item.current-version {
		border-width: 1px;
	}

	.release-tag-item.development-version {
		border-width: 1px;
	}

	.release-tag-item.main-branch-version {
		border-width: 1px;
	}

	.release-tag-item.beta-version {
		font-weight: bold;
	}

	.release-tag-item.stable-version {
		font-weight: bold;
	}

	.prerelease-badge {
		font-size: 0.7em;
		color: var(--text-on-accent);
		border-radius: 4px;
		padding: 2px 6px;
		margin-left: 8px;
		vertical-align: middle;
		text-transform: uppercase;
	}

	.channel-badge {
		font-size: 0.7em;
		border-radius: 4px;
		padding: 2px 6px;
		margin-left: 8px;
		vertical-align: middle;
		text-transform: uppercase;
	}

	.beta-badge {
		background-color: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.stable-badge {
		background-color: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.tag-name {
		font-weight: bold;
		font-size: 0.8em;
		display: flex;
		align-items: center;
	}

	/* Manifest container styling */
	.manifest-container {
		flex: 1;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		background-color: var(--background-secondary);
		margin: 0 1rem 1rem;
		overflow: hidden;
	}

	.manifest-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px;
		background-color: var(--background-secondary-alt);
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.manifest-header h3 {
		margin: 0;
		font-size: 1.1em;
		color: var(--text-normal);
		display: flex;
		align-items: center;
	}

	.manifest-header-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.manifest-close-btn {
		cursor: pointer;
		font-size: 1.2em;
		background: transparent;
		border: none;
		color: var(--text-normal);
	}

	.manifest-content {
		padding: 16px;
		border-top: 1px solid var(--background-modifier-border);
	}

	.manifest-field {
		margin-bottom: 8px;
		display: flex;
		align-items: flex-start;
	}

	.manifest-label {
		font-weight: bold;
		min-width: 120px;
		color: var(--text-normal);
	}

	.manifest-value {
		flex: 1;
	}

	.manifest-version-mismatch {
		margin-left: 10px;
		color: var(--text-error);
		font-size: 0.85em;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.manifest-version-mismatch-icon {
		font-size: 1.2em;
	}

	.release-changelog {
		padding: 16px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		height: 320px;
	}

	.release-changelog-content {
		overflow-x: auto;
		margin: 0;
		font-size: 0.85em;
		flex: 1;
		overflow-y: auto;
		line-height: 1.4;
	}

	.currently-installed {
		color: var(--interactive-accent);
		font-weight: bold;
		padding: 4px 8px;
		border-radius: 4px;
	}

	.install-version-btn {
		font-size: 0.9em;
		padding: 4px 12px;
		cursor: pointer;
	}

	.manifest-error {
		padding: 16px;
		text-align: center;
		background-color: var(--background-modifier-error);
		border-radius: 6px;
		color: var(--text-on-accent);
		margin: 0 1rem 1rem;
	}

	.manifest-error-message {
		margin-bottom: 12px;
	}
</style>
