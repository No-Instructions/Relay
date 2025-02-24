<script lang="ts">
	import { writable } from "svelte/store";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import { debounce } from "obsidian";
	import type Live from "../main";
	import { onDestroy, onMount } from "svelte";
	import type { UpdateInfo } from "../UpdateManager";
	import type { App } from "obsidian";

	export let plugin: Live;

	const currentVersion = writable<string>(plugin.manifest.version);
	const updateAvailable = writable<boolean>(false);
	const newVersion = writable<string>("");
	const repository = writable<string>("");
	
	// Store for GitHub releases - we'll access cached releases directly from UpdateManager
	const loadingReleases = writable<boolean>(false);
	const showAllReleases = writable<boolean>(false);
	const filteredReleases = writable<any[]>([]);
	
	// Toggle for overwriting manifest version with Git tag on install
	const overwriteVersionOnInstall = writable<boolean>(true);
	
	// Manifest viewing
	const selectedManifest = writable<any | null>(null);
	const selectedManifestTag = writable<string>("");
	const loadingManifest = writable<string | null>(null);
	const manifestError = writable<string | null>(null);
	
	// Installation status
	let installingUpdate = false;
	const installingVersion = writable<string | null>(null);
	
	// Keep a reference to the app for plugin installation
	// This is important as the plugin instance may be unloaded during update
	const app = plugin.app;
	const pluginId = "system3-relay";

	// Get access to the GIT_TAG declared in main.ts
	declare const GIT_TAG: string;

	// No need for unsubscriber with reactive bindings

	// Helper functions to handle version comparisons
	function normalizeVersion(version: string): string {
		// Remove leading 'v' if present
		return version.startsWith('v') ? version.substring(1) : version;
	}
	
	// Check if a tag represents the current Git tag
	function isCurrentVersion(tagName: string): boolean {
		const normalizedTag = normalizeVersion(tagName);
		const normalizedGitTag = normalizeVersion(GIT_TAG);
		return normalizedTag === normalizedGitTag;
	}
	
	// Check if a tag represents the available update version
	function isUpdateVersion(tagName: string): boolean {
		if (!$updateAvailable) return false;
		
		const normalizedTag = normalizeVersion(tagName);
		const normalizedUpdate = normalizeVersion($newVersion);
		return normalizedTag === normalizedUpdate;
	}
	
	// Check if a release tag mismatches its manifest version
	function hasVersionMismatch(tagName: string, manifestVersion?: string): boolean {
		if (!manifestVersion) return false;
		
		const tagVersion = normalizeVersion(tagName);
		const normalizedManifestVersion = normalizeVersion(manifestVersion);
		return tagVersion !== normalizedManifestVersion;
	}
	
	// Store for tracking manifest versions
	const manifestVersions = writable<Record<string, string>>({});
	
	onMount(() => {
		// Initial setup - check GitHub releases immediately
		refreshGithubReleases();
	});
	
	// Access GitHub releases directly from the UpdateManager
	$: githubReleases = plugin.updateManager ? plugin.updateManager.getGitHubReleases() : [];
	
	// When releases change, fetch their manifests to check for version mismatches
	$: {
		if (githubReleases && githubReleases.length > 0) {
			// Pre-fetch manifests for all releases to check for mismatches
			githubReleases.forEach(async (release) => {
				try {
					const manifest = await plugin.updateManager.fetchReleaseManifest(release.tag_name);
					if (manifest) {
						manifestVersions.update(versions => ({ 
							...versions, 
							[release.tag_name]: manifest.version 
						}));
					}
				} catch (e) {
					// Just continue if we can't fetch a manifest
				}
			});
		}
	}
	
	// Refresh releases (forces a new fetch if needed)
	async function refreshGithubReleases() {
		loadingReleases.set(true);
		try {
			await plugin.updateManager.checkGitHubReleases();
			// The reactive binding to githubReleases will update automatically
			// so we just need to filter them based on current settings
			filterReleases($showAllReleases);
		} catch (error) {
			plugin.error("Error refreshing GitHub releases:", error);
		} finally {
			loadingReleases.set(false);
		}
	}
	
	// Function to check if a version string follows semver
	function isSemver(version: string): boolean {
		// Remove leading 'v' if present
		if (version.startsWith('v')) {
			version = version.substring(1);
		}
		
		// Basic semver regex (Major.Minor.Patch)
		const semverRegex = /^\d+\.\d+\.\d+$/;
		return semverRegex.test(version);
	}
	
	// Filter releases based on show all toggle
	function filterReleases(showAll: boolean) {
		if (showAll) {
			// Show all releases
			filteredReleases.set(githubReleases);
		} else {
			// Show only semver releases
			filteredReleases.set(githubReleases.filter(release => {
				const tagName = release.tag_name;
				return isSemver(tagName);
			}));
		}
	}
	
	// Update filtered releases when githubReleases changes or when toggle changes
	$: {
		if (githubReleases && githubReleases.length > 0) {
			filterReleases($showAllReleases);
		} else {
			filteredReleases.set([]);
		}
	}
	
	// Function to fetch and view release details for a specific release
	async function viewReleaseManifest(tagName: string) {
		// Reset any previous errors
		manifestError.set(null);
		
		// Set loading state for this specific tag
		loadingManifest.set(tagName);
		
		try {
			const manifest = await plugin.updateManager.fetchReleaseManifest(tagName);
			
			if (manifest) {
				selectedManifest.set(manifest);
				selectedManifestTag.set(tagName);
				
				// Also update the manifest versions cache
				manifestVersions.update(versions => ({ 
					...versions, 
					[tagName]: manifest.version 
				}));
			} else {
				manifestError.set(`Could not find manifest for ${tagName}`);
			}
		} catch (error) {
			plugin.error("Error fetching manifest:", error);
			manifestError.set(`Error fetching manifest: ${error.message || "Unknown error"}`);
		} finally {
			loadingManifest.set(null);
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
		return githubReleases.find(r => r.tag_name === tagName);
	}
	
	// Use $ syntax to access updateManager directly (reactive access)
	// This way we automatically get updates when updateManager changes
	$: updateInfo = plugin.updateManager ? plugin.updateManager.getUpdateInfo() : null;

	$: {
		// Update the state whenever updateInfo changes
		updateAvailable.set(!!updateInfo && updateInfo.newVersion !== plugin.manifest.version);
		
		if (updateInfo) {
			newVersion.set(updateInfo.newVersion);
			repository.set(updateInfo.repository);
		} else {
			newVersion.set("");
			repository.set("");
		}
	}
	
	// Function to install a specific version from GitHub release
	async function installSpecificVersion(tagName: string) {
		try {
			// Set installing state for this specific version
			installingVersion.set(tagName);
			
			// Store references to what we need before the plugin is unloaded
			// This is crucial since the plugin instance may become null during installation
			const repoPath = "No-Instructions/Relay";
			
			// First fetch the manifest to get required information
			const manifest = await plugin.updateManager.fetchReleaseManifest(tagName);
			
			if (!manifest) {
				plugin.error(`Could not find manifest for ${tagName}`);
				return;
			}
			
			// Optionally overwrite the manifest version with the Git tag
			if ($overwriteVersionOnInstall) {
				// Remove 'v' prefix if present for the version field
				const normalizedTag = normalizeVersion(tagName);
				manifest.version = normalizedTag;
				plugin.log(`Overwriting manifest version with Git tag: ${normalizedTag}`);
			}
			
			// Show installing status
			installingUpdate = true;
			
			// Use the cached app reference instead of plugin.app which might become null
			await app.plugins.installPlugin(
				repoPath, 
				tagName,
				manifest
			);
			
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

<div class="modal-title">Release Manager</div>
<div class="modal-content">
	<div class="settings-spacer"></div>
	
	<SlimSettingItem name="Show All Releases">
		<div 
			role="checkbox"
			aria-checked={$showAllReleases} 
			tabindex="0"
			class="checkbox-container"
			class:is-enabled={$showAllReleases}
			on:click={() => {
				showAllReleases.update(v => !v);
				filterReleases(!$showAllReleases);
			}}
		>
			<input type="checkbox" tabindex="-1" checked={$showAllReleases} />
			<div class="checkbox-toggle"></div>
		</div>
	</SlimSettingItem>
	
	<SlimSettingItem name="Use Git tag as version">
		<div 
			role="checkbox"
			aria-checked={$overwriteVersionOnInstall} 
			tabindex="0"
			class="checkbox-container"
			class:is-enabled={$overwriteVersionOnInstall}
			on:click={() => {
				overwriteVersionOnInstall.update(v => !v);
			}}
		>
			<input type="checkbox" tabindex="-1" checked={$overwriteVersionOnInstall} />
			<div class="checkbox-toggle"></div>
		</div>
	</SlimSettingItem>
	
	{#if $loadingReleases}
		<div class="loading-text">Loading GitHub releases...</div>
	{:else if githubReleases.length === 0}
		<div class="no-releases-text">No GitHub releases found</div>
	{:else if $filteredReleases.length === 0}
		<div class="no-releases-text">No matching releases found with the current filter</div>
	{:else if $selectedManifest}
		<div class="manifest-container">
			<div class="manifest-header">
				<h3>Release Details</h3>
				<button 
					class="manifest-close-btn"
					on:click={closeManifestView}
				>
					×
				</button>
			</div>
			<div class="manifest-content">
				<div class="manifest-field manifest-field-highlight">
					<span class="manifest-label">Git Tag:</span>
					<span class="manifest-value">{$selectedManifestTag}</span>
				</div>
				<div class="manifest-field">
					<span class="manifest-label">Version:</span>
					<span class="manifest-value">{$selectedManifest.version}</span>
					{#if $selectedManifestTag !== $selectedManifest.version && !$selectedManifestTag.startsWith('v' + $selectedManifest.version)}
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
					<span class="manifest-value">{$selectedManifest.description}</span>
				</div>
				<div class="manifest-field">
					<span class="manifest-label">isDesktopOnly:</span>
					<span class="manifest-value">{$selectedManifest.isDesktopOnly ? 'Yes' : 'No'}</span>
				</div>
				<div class="manifest-field">
					<span class="manifest-label">minAppVersion:</span>
					<span class="manifest-value">{$selectedManifest.minAppVersion}</span>
				</div>
			</div>
			<!-- Show changelog in addition to manifest details -->
			<div class="release-changelog">
				<div class="release-changelog-header">Changelog:</div>
				<div class="release-changelog-content">
					{@html $selectedManifestTag ? 
						(findReleaseByTag($selectedManifestTag)?.body?.replace(/\n/g, '<br/>') || 'No changelog available') 
						: 'No changelog available'
					}
				</div>
			</div>
			
			<div class="manifest-raw">
				<div class="manifest-raw-header">Manifest JSON:</div>
				<pre>{JSON.stringify($selectedManifest, null, 2)}</pre>
			</div>
		</div>
	{:else if $manifestError}
		<div class="manifest-error">
			<div class="manifest-error-message">{$manifestError}</div>
			<button 
				class="manifest-close-btn"
				on:click={closeManifestView}
			>
				Close
			</button>
		</div>
	{:else}
		<div class="releases-container">
			<div class="releases-count">
				Showing {$filteredReleases.length} of {githubReleases.length} releases
			</div>
			
			<!-- Only show the development version entry when not running a released version -->
			{#if !$filteredReleases.some(release => isCurrentVersion(release.tag_name))}
				<div class="release-item development-version-entry">
					<div class="release-header development-version">
						<div class="release-info">
							<span class="release-tag">{GIT_TAG}</span>
							<span class="release-current">Development</span>
						</div>
					</div>
					<!-- No body text needed -->
				</div>
			{/if}
			
			{#each $filteredReleases as release}
				<div class="release-item">
					<div class="release-header {isCurrentVersion(release.tag_name) ? 'current-version' : ''}">
						<div class="release-info">
							<span class="release-tag">{release.tag_name}</span>
							{#if release.prerelease}
								<span class="release-prerelease">Pre-release</span>
							{/if}
							{#if isCurrentVersion(release.tag_name)}
								<span class="release-current">Installed</span>
							{/if}
							{#if isUpdateVersion(release.tag_name)}
								<span class="release-update">Update Available</span>
							{/if}
							
							<!-- Show version mismatch warning if we've loaded the manifest -->
							{#if $manifestVersions[release.tag_name] && hasVersionMismatch(release.tag_name, $manifestVersions[release.tag_name])}
								<span class="release-version-mismatch">
									<span class="release-version-mismatch-icon">⚠️</span>
									Tag/Manifest mismatch
								</span>
							{/if}
						</div>
						<div class="release-buttons">
							<button 
								class="view-manifest-btn"
								on:click={() => viewReleaseManifest(release.tag_name)}
								disabled={$loadingManifest === release.tag_name}
							>
								{$loadingManifest === release.tag_name ? 'Loading...' : 'Show More Info'}
							</button>
							<button 
								class="install-version-btn mod-cta"
								on:click={() => installSpecificVersion(release.tag_name)}
								disabled={$installingVersion === release.tag_name || installingUpdate}
							>
								{#if $installingVersion === release.tag_name}
									Installing...
								{:else}
									Install
								{/if}
							</button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* Basic padding on modal content */
	.modal-content {
		padding: 0;
	}
	
	/* Add padding to settings area */
	:global(.modal-content > .setting-item),
	:global(.modal-content > .setting-item-heading) {
		padding-left: 1rem;
		padding-right: 1rem;
	}
	
	/* Add space before the first settings item */
	.settings-spacer {
		height: 1rem;
	}
	
	/* We use Obsidian's default toggle styling */
	.checkbox-container {
		cursor: pointer;
	}
	
	.loading-text, .no-releases-text {
		padding: 12px;
		text-align: center;
		color: var(--text-muted);
		font-style: italic;
	}
	
	.releases-container {
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin-top: 8px;
		max-height: 400px;
		overflow-y: auto;
		padding: 0 8px;
	}
	
	.releases-count {
		font-size: 0.8em;
		color: var(--text-muted);
		text-align: right;
		margin-bottom: 8px;
		padding-right: 4px;
	}
	
	.release-item {
		border: 1px solid var(--background-modifier-border);
		border-radius: 6px;
		background-color: var(--background-secondary);
		margin-bottom: 8px;
		overflow: hidden;
	}
	
	.development-version-entry {
		border-color: var(--interactive-accent);
		box-shadow: 0 0 5px var(--background-modifier-border);
	}
	
	.release-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		padding: 12px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	
	.release-header.current-version {
		background-color: var(--background-primary-alt);
		border-left: 4px solid var(--interactive-accent);
	}
	
	.release-header.development-version {
		background-color: var(--background-primary-alt);
		border-left: 4px solid var(--interactive-accent);
	}
	
	.release-info {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	
	.release-tag {
		font-weight: bold;
		color: var(--text-normal);
	}
	
	.release-name {
		font-weight: bold;
	}
	
	/* Common pill styling */
	.pill-base, .release-prerelease, .release-current, .release-update, .release-version-mismatch, .release-version-unreleased {
		height: 20px;
		line-height: 20px;
		font-size: 0.8em;
		padding: 0 6px;
		border-radius: 4px;
		display: inline-flex;
		align-items: center;
	}
	
	.release-prerelease {
		background-color: var(--background-modifier-error);
		color: var(--text-on-accent);
	}
	
	.release-current {
		background-color: var(--interactive-accent);
		color: var(--text-on-accent);
	}
	
	/* We use .release-current for all currently installed versions */
	
	.release-update {
		background-color: var(--text-success);
		color: var(--text-on-accent);
	}
	
	.release-version-mismatch {
		background-color: var(--background-modifier-error);
		color: var(--text-on-accent);
		gap: 4px;
	}
	
	.release-version-mismatch-icon {
		font-size: 0.9em;
		line-height: 1;
	}
	
	.release-version-unreleased {
		background-color: var(--background-modifier-border);
		color: var(--text-muted);
	}
	
	/* Release date styling removed */
	
	.release-body {
		font-size: 0.9em;
		line-height: 1.4;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		max-height: 200px;
		overflow-y: auto;
	}
	
	/* Release button styles */
	.release-buttons {
		margin-left: auto;
		display: flex;
		gap: 8px;
	}
	
	/* Use Obsidian's default button styling */
	.view-manifest-btn, .install-version-btn {
		font-size: 0.8em;
		cursor: pointer;
	}
	
	.view-manifest-btn:disabled, .install-version-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	
	/* No custom styling needed - using Obsidian's mod-cta class */
	
	/* Manifest view styles */
	.manifest-container {
		border: 1px solid var(--background-modifier-border);
		border-radius: 6px;
		background-color: var(--background-secondary);
		margin-top: 12px;
		max-height: 500px;
		overflow-y: auto;
	}
	
	.manifest-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 16px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	
	.manifest-header h3 {
		margin: 0;
		font-size: 1.2em;
	}
	
	/* Use Obsidian's default close button styling */
	.manifest-close-btn {
		cursor: pointer;
	}
	
	.manifest-content {
		padding: 16px;
	}
	
	.manifest-field {
		margin-bottom: 8px;
		display: flex;
		align-items: center;
	}
	
	.manifest-field-highlight {
		background-color: var(--background-primary-alt);
		padding: 6px;
		border-radius: 4px;
		margin: -6px -6px 8px -6px;
	}
	
	.manifest-label {
		font-weight: bold;
		min-width: 120px;
		color: var(--text-accent);
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
		border-top: 1px solid var(--background-modifier-border);
	}
	
	.release-changelog-header {
		font-weight: bold;
		margin-bottom: 8px;
		color: var(--text-accent);
	}
	
	.release-changelog-content {
		background-color: var(--background-primary);
		padding: 12px;
		border-radius: 4px;
		overflow-x: auto;
		margin: 0;
		font-size: 0.85em;
		max-height: 200px;
		overflow-y: auto;
		line-height: 1.4;
	}
	
	.manifest-raw {
		padding: 16px;
		border-top: 1px solid var(--background-modifier-border);
	}
	
	.manifest-raw-header {
		font-weight: bold;
		margin-bottom: 8px;
		color: var(--text-accent);
	}
	
	.manifest-raw pre {
		background-color: var(--background-primary);
		padding: 12px;
		border-radius: 4px;
		overflow-x: auto;
		margin: 0;
		font-size: 0.85em;
	}
	
	.manifest-error {
		padding: 16px;
		text-align: center;
		background-color: var(--background-modifier-error);
		border-radius: 6px;
		color: var(--text-on-accent);
		margin-top: 12px;
	}
	
	.manifest-error-message {
		margin-bottom: 12px;
	}
</style>