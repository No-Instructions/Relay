import { Plugin } from "obsidian";
import type { TimeProvider } from "./TimeProvider";
import { Observable } from "./observable/Observable";
import { customFetch } from "./customFetch";

export type WithPlugins = {
	plugins: {
		disablePlugin(id: string): Promise<void>;
		enablePlugin(id: string): Promise<void>;
		installPlugin(
			repository: string,
			version: string,
			manifest: any,
		): Promise<void>;
	};
};
export type PluginWithApp = Plugin & { app: WithPlugins };

export interface UpdateInfo {
	currentVersion: string;
	newVersion: string;
	repository: string;
	manifest: any;
}

/**
 * Manages plugin update checking and installation
 */
export class UpdateManager extends Observable<UpdateInfo | null> {
	private updateCheckInterval: number | null = null;
	private releaseCheckInterval: number | null = null;
	private updateInfo: UpdateInfo | null = null;
	private githubReleases: any[] = [];
	private lastReleaseCheck: number = 0;
	private readonly CHECK_INTERVAL = 1000 * 60 * 60 * 24; // Check once a day
	private readonly RELEASES_CHECK_INTERVAL = 1000 * 60 * 60; // Check GitHub releases every hour

	constructor(
		private plugin: PluginWithApp,
		private timeProvider: TimeProvider,
	) {
		super("UpdateManager");
		// Observable base class already implements HasLogging and initializes _listeners
	}

	/**
	 * Start periodic update checking and releases fetching
	 */
	public start(): void {
		// Start checking for updates
		this.checkForUpdates();
		this.updateCheckInterval = this.timeProvider.setInterval(
			() => this.checkForUpdates(),
			this.CHECK_INTERVAL,
		);

		// Also fetch GitHub releases initially and start periodic checks
		this.checkGitHubReleases();
		this.releaseCheckInterval = this.timeProvider.setInterval(
			() => this.checkGitHubReleases(),
			this.RELEASES_CHECK_INTERVAL,
		);
	}

	/**
	 * Stop periodic update checking and releases fetching
	 */
	public stop(): void {
		if (this.updateCheckInterval !== null) {
			this.timeProvider.clearInterval(this.updateCheckInterval);
			this.updateCheckInterval = null;
		}

		if (this.releaseCheckInterval !== null) {
			this.timeProvider.clearInterval(this.releaseCheckInterval);
			this.releaseCheckInterval = null;
		}
	}

	/**
	 * Check for available updates
	 */
	public async checkForUpdates(): Promise<boolean> {
		try {
			// First fetch all releases
			await this.checkGitHubReleases();
			if (this.githubReleases.length === 0) {
				this.debug("No releases found");
				return false;
			}

			const currentVersion = this.plugin.manifest.version;
			let newUpdateInfo: UpdateInfo | null = null;

			// Go through releases from newest to oldest
			for (const release of this.githubReleases) {
				// Try to fetch both stable and beta manifests from release assets
				const stableManifest = await this.fetchReleaseManifest(release, false);
				const betaManifest = await this.fetchReleaseManifest(release, true);

				// Check stable manifest first
				if (stableManifest && stableManifest.version !== currentVersion) {
					newUpdateInfo = {
						currentVersion: currentVersion,
						newVersion: stableManifest.version,
						repository: "No-Instructions/Relay",
						manifest: stableManifest,
					};
					this.debug("Found stable update:", newUpdateInfo);
					break;
				}
				// Then check beta manifest
				else if (betaManifest && betaManifest.version !== currentVersion) {
					newUpdateInfo = {
						currentVersion: currentVersion,
						newVersion: betaManifest.version,
						repository: "No-Instructions/Relay",
						manifest: betaManifest,
					};
					this.debug("Found beta update:", newUpdateInfo);
					break;
				}
			}

			// Check if update state changed
			const hasChanged =
				(this.updateInfo === null && newUpdateInfo !== null) ||
				(this.updateInfo !== null && newUpdateInfo === null) ||
				(this.updateInfo !== null &&
					newUpdateInfo !== null &&
					this.updateInfo.newVersion !== newUpdateInfo.newVersion);

			// Update state
			this.updateInfo = newUpdateInfo;

			// Notify only if state changed
			if (hasChanged) {
				this.debug("Update state changed, notifying listeners");
				this.notifyListeners();
			}

			return newUpdateInfo !== null;
		} catch (error) {
			this.error("Failed to check for updates:", error);
			return false;
		}
	}

	/**
	 * Get current update info if available
	 */
	public getUpdateInfo(): UpdateInfo | null {
		return this.updateInfo;
	}

	/**
	 * Check if an update is available
	 */
	public isUpdateAvailable(): boolean {
		return this.updateInfo !== null;
	}

	/**
	 * Install the available update
	 */
	public async installUpdate(): Promise<boolean> {
		if (!this.updateInfo) {
			this.debug("No updates available");
			return false;
		}

		// Validate update info has all required properties
		const { currentVersion, newVersion, repository, manifest } =
			this.updateInfo;
		if (!newVersion || !repository || !manifest) {
			this.error("Update information is incomplete", this.updateInfo);
			this.updateInfo = null; // Reset invalid state
			this.notifyListeners();
			return false;
		}

		try {
			this.debug(
				`Installing update from v${currentVersion} to v${newVersion}...`,
			);

			this.debug("Installing plugin with parameters:", {
				repository,
				newVersion,
				manifest,
			});

			await this.plugin.app.plugins.installPlugin(
				repository,
				newVersion,
				manifest,
			);

			this.updateInfo = null;
			this.notifyListeners();

			this.debug("Update complete. Reloading plugin...");

			// Reload the plugin - use the correct plugin ID
			const pluginId = "system3-relay";
			const plugins = this.plugin.app.plugins;
			await plugins.disablePlugin(pluginId);
			await plugins.enablePlugin(pluginId);

			return true;
		} catch (error) {
			this.error("Failed to install update:", error);
			return false;
		}
	}

	/**
	 * Check for GitHub releases and cache them
	 * This is called periodically and caches the results
	 */
	public async checkGitHubReleases(): Promise<boolean> {
		try {
			// Only fetch if we haven't fetched in a while to avoid rate limiting
			const now = Date.now();
			if (
				now - this.lastReleaseCheck < 5 * 60 * 1000 &&
				this.githubReleases.length > 0
			) {
				// If we've checked in the last 5 minutes and have data, just return the cached data
				return true;
			}

			// Update the last check timestamp
			this.lastReleaseCheck = now;

			// GitHub API endpoint for releases
			const repoOwner = "No-Instructions";
			const repoName = "Relay";
			const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases`;

			// Use customFetch for fetching
			const response = await customFetch(apiUrl, {
				headers: {
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "Relay-Obsidian-Plugin",
				},
			});

			if (!response.ok) {
				throw new Error(`GitHub API error: ${response.status}`);
			}

			const releases = await response.json();
			this.debug("GitHub releases fetched:", releases);

			// Update our cached releases
			this.githubReleases = releases;

			// Notify subscribers that we have new releases data
			this.notifyListeners();

			return true;
		} catch (error) {
			this.error("Failed to fetch GitHub releases:", error);
			return false;
		}
	}

	/**
	 * Fetches GitHub releases for the plugin repository
	 * Returns cached data if available, or fetches fresh data if needed
	 * @returns Array of release information
	 */
	public async fetchGitHubReleases(): Promise<any[]> {
		// If we have cached releases, return them immediately
		if (this.githubReleases.length > 0) {
			return this.githubReleases;
		}

		// Otherwise fetch them (this will also update the cache)
		await this.checkGitHubReleases();
		return this.githubReleases;
	}

	/**
	 * Fetches the manifest file from a release's assets
	 * @param release The GitHub release object
	 * @param beta Whether to fetch the beta manifest
	 * @returns The parsed manifest object or null if not found
	 */
	public async fetchReleaseManifest(
		release: any,
		beta: boolean = false,
	): Promise<any | null> {
		try {
			const manifestFileName = beta ? "manifest-beta.json" : "manifest.json";

			// Find the manifest asset in the release
			const manifestAsset = release.assets.find(
				(asset: any) => asset.name === manifestFileName,
			);

			if (!manifestAsset) {
				this.debug(`No ${manifestFileName} found in release assets`);
				return null;
			}

			this.debug(
				`Fetching ${beta ? "beta" : "stable"} manifest from release asset:`,
				manifestAsset.browser_download_url,
			);

			const response = await customFetch(manifestAsset.browser_download_url, {
				headers: {
					Accept: "application/octet-stream",
					"User-Agent": "Relay-Obsidian-Plugin",
				},
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch manifest asset: ${response.status}`);
			}

			const manifest = await response.json();
			this.debug(`${beta ? "Beta" : "Stable"} manifest fetched:`, manifest);
			return manifest;
		} catch (error) {
			this.error(
				`Failed to fetch ${beta ? "beta" : "stable"} release manifest:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Fetches the main branch manifest files (stable and beta)
	 * @returns Object containing both stable and beta manifest data, or null on failure
	 */
	public async fetchMainBranchManifests(): Promise<{
		stable: any | null;
		beta: any | null;
	} | null> {
		try {
			const repoOwner = "No-Instructions";
			const repoName = "Relay";
			const stableManifestUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/main/manifest.json`;
			const betaManifestUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/main/manifest-beta.json`;

			this.debug(`Fetching stable manifest from: ${stableManifestUrl}`);
			this.debug(`Fetching beta manifest from: ${betaManifestUrl}`);

			// Fetch both manifests in parallel
			const [stableResponse, betaResponse] = await Promise.all([
				customFetch(stableManifestUrl, {
					headers: {
						"User-Agent": "Relay-Obsidian-Plugin",
					},
				}),
				customFetch(betaManifestUrl, {
					headers: {
						"User-Agent": "Relay-Obsidian-Plugin",
					},
				}),
			]);

			// Parse the stable manifest
			let stableManifest = null;
			if (stableResponse.ok) {
				stableManifest = await stableResponse.json();
				this.debug("Stable manifest fetched:", stableManifest);
			} else {
				this.debug(`Failed to fetch stable manifest: ${stableResponse.status}`);
			}

			// Parse the beta manifest
			let betaManifest = null;
			if (betaResponse.ok) {
				betaManifest = await betaResponse.json();
				this.debug("Beta manifest fetched:", betaManifest);
			} else {
				this.debug(`Failed to fetch beta manifest: ${betaResponse.status}`);
			}

			return { stable: stableManifest, beta: betaManifest };
		} catch (error) {
			this.error("Failed to fetch main branch manifests:", error);
			return null;
		}
	}

	/**
	 * Get the cached GitHub releases
	 * This can be used in UI to immediately show cached releases without waiting for async fetch
	 */
	public getGitHubReleases(): any[] {
		return this.githubReleases;
	}

	override destroy(): void {
		// Stop periodic update checking
		this.stop();

		// Set state to null before destroying
		this.updateInfo = null;
		this.githubReleases = [];

		// Let the parent class handle its own cleanup
		super.destroy();
	}
}
