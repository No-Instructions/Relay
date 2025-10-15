import { Plugin } from "obsidian";
import type { TimeProvider } from "./TimeProvider";
import { Observable } from "./observable/Observable";
import { customFetch } from "./customFetch";
import { LocalStorage } from "./LocalStorage";
import type { NamespacedSettings } from "./SettingsStorage";
import { flags } from "./flagManager";

declare const REPOSITORY: string;

// Private Obsidian API
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
export type PluginWithApp = Plugin & { app: WithPlugins; version: string };

interface Asset {
	name: string;
	browser_download_url: string;
}

export interface Release {
	tag_name: string;
	assets: Asset[];
	prerelease: boolean;
	draft: boolean;
	body: string;
	created_at: string;
	latest?: boolean;
}

export interface Manifest {
	version: string;
	name: string;
	author: string;
	description: string;
	isDesktopOnly: boolean;
	minAppVersion: string;
}

export interface ReleaseSettings {
	channel: "stable" | "beta";
}

function normalizeVersion(tag: string) {
	if (tag.startsWith("v")) {
		return tag.slice(1);
	}
	return tag;
}

function zip<T, U>(arr1: T[], arr2: U[]): [T, U][] {
	return arr1.map((item, index) => [item, arr2[index]]);
}

function updateAvailable(versionTag: string, pluginTag: string): boolean {
	try {
		const updateVersion = normalizeVersion(versionTag).split(".").map(parseInt);
		const pluginVersion = normalizeVersion(pluginTag).split(".").map(parseInt);
		for (const [update, plugin] of zip(updateVersion, pluginVersion)) {
			if (update > plugin) {
				return true;
			}
		}
	} catch (e) {
		// pass
	}
	return false;
}

export class UpdateManager extends Observable<UpdateManager> {
	private updateCheckInterval: number | null = null;
	private githubReleases: LocalStorage<Release>;
	private releaseChannels: LocalStorage<Release>;
	private lastReleaseCheck: number = 0;
	private lastChannelCheck: number = 0;
	private readonly CHECK_INTERVAL = 1000 * 60 * 60 * 24;
	observableName = "UpdateManager";

	constructor(
		private plugin: PluginWithApp,
		private timeProvider: TimeProvider,
		private releaseSettings: NamespacedSettings<ReleaseSettings>,
	) {
		super("UpdateManager");
		this.githubReleases = new LocalStorage("system3-relay/releases");
		this.releaseChannels = new LocalStorage("system3-relay/releaseChannels");
	}

	public get releases(): Release[] {
		return [...this.githubReleases.values()].sort((a, b) =>
			b.tag_name.localeCompare(a.tag_name, undefined, {
				numeric: true,
				sensitivity: "base",
			}),
		);
	}

	public get beta(): Release | undefined {
		return this.releaseChannels.get("beta");
	}

	public get stable(): Release | undefined {
		return this.releaseChannels.get("stable");
	}

	private async fetchReleases(): Promise<Release[]> {
		const apiUrl = `https://api.github.com/repos/${REPOSITORY}/releases`;

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

		if (flags().enableNetworkLogging) {
			this.debug("GitHub releases fetched:", releases);
		}

		return releases;
	}

	private async fetchLatestRelease(): Promise<Release | null> {
		try {
			const repoOwner = "No-Instructions";
			const repoName = "Relay";
			const latestUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;

			this.debug(`Fetching latest release from: ${latestUrl}`);
			const response = await customFetch(latestUrl, {
				headers: {
					"User-Agent": "Relay-Obsidian-Plugin",
				},
			});
			if (!response.ok) {
				throw new Error(`GitHub API error: ${response.status}`);
			}
			const latestRelease = await response.json();
			return latestRelease;
		} catch (error) {
			this.error(`Failed to fetch latest release:`, error);
			return null;
		}
	}

	public async fetchLatestTagFromChannel(
		channel: "beta" | "stable",
	): Promise<string | null> {
		try {
			const manifestPath = {
				beta: "manifest-beta.json",
				stable: "manifest.json",
			}[channel];

			const manifest = manifestPath
				? await this.fetchRepoManifest(manifestPath)
				: null;
			if (!manifest) {
				return null;
			}
			this.debug("repo manifest", manifest);
			return manifest.version;
		} catch (error) {
			this.error("Failed to check for updates:", error);
		}
		return null;
	}

	public async getReleases(): Promise<Release[]> {
		try {
			// Only fetch if we haven't fetched in a while to avoid rate limiting
			const now = Date.now();
			if (
				now - this.lastReleaseCheck < 5 * 60 * 1000 &&
				this.githubReleases.size > 0
			) {
				// If we've checked in the last 5 minutes and have data, just return the cached data
				return [...this.githubReleases.values()];
			}

			// Update the last check timestamp
			this.lastReleaseCheck = now;

			const releases = await this.fetchReleases();
			const localReleases = new Set<string>([...this.githubReleases.keys()]);
			const remoteReleases = new Set<string>();
			releases.forEach((release: Release) => {
				this.githubReleases.set(release.tag_name, release);
				remoteReleases.add(release.tag_name);
			});

			// Cleanup deleted releases
			localReleases.forEach((releaseTag) => {
				if (!remoteReleases.has(releaseTag)) {
					this.githubReleases.delete(releaseTag);
				}
			});

			const latest = await this.fetchLatestRelease();
			if (latest) {
				latest.latest = true;
				this.githubReleases.set(latest.tag_name, latest);
			}

			// Notify subscribers that we have new releases data
			this.notifyListeners();
		} catch (error) {
			this.error("Failed to fetch GitHub releases:", error);
		}
		return [...this.githubReleases.values()];
	}

	private async getChannelRelease(): Promise<Release | null> {
		const now = Date.now();
		const channelRelease = this.releaseChannels.get(
			this.releaseSettings.get().channel,
		);
		if (now - this.lastChannelCheck < 5 * 60 * 1000 && channelRelease) {
			return channelRelease;
		}
		this.lastReleaseCheck = now;

		const releases = await this.getReleases();
		if (releases.length === 0) {
			this.debug("No releases found");
			return null;
		}

		const channel = this.releaseSettings.get().channel;
		if (!channel) return null;

		const version = await this.fetchLatestTagFromChannel(channel);
		if (!version) return null;

		const release = releases.find((release) => {
			return normalizeVersion(release.tag_name) === version;
		});
		if (release) {
			this.releaseChannels.set(channel, release);
			this.notifyListeners();
			return release;
		}
		return null;
	}

	private async update() {
		await this.getReleases();
		await this.getChannelRelease();
	}

	public start(): void {
		this.update();
		this.updateCheckInterval = this.timeProvider.setInterval(
			() => this.update(),
			this.CHECK_INTERVAL,
		);
	}

	public stop(): void {
		if (this.updateCheckInterval !== null) {
			this.timeProvider.clearInterval(this.updateCheckInterval);
			this.updateCheckInterval = null;
		}
	}

	public async fetchRepoManifest(
		path: string,
		branch = "main",
	): Promise<Manifest | null> {
		try {
			const repoOwner = "No-Instructions";
			const repoName = "Relay";
			const fileUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/${path}`;

			this.debug(`Fetching ${fileUrl}`);

			// Fetch both manifests in parallel
			const response = await customFetch(fileUrl);

			if (!response.ok) {
				throw new Error("unable to fetch manifest");
			}
			return await response.json();
		} catch (error) {
			this.error("Failed to fetch:", error);
			return null;
		}
	}

	public async fetchReleaseManifest(release: Release): Promise<any | null> {
		try {
			// Find the manifest asset in the release
			const manifestAsset = release.assets.find(
				(asset: any) => asset.name === "manifest.json",
			);

			if (!manifestAsset) {
				this.debug("No manifest found in release assets");
				return null;
			}

			this.debug(
				`Fetching manifest from release asset:`,
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
			if (flags().enableNetworkLogging) {
				this.debug("manifest fetched:", manifest);
			}
			return manifest;
		} catch (error) {
			this.error("Failed to fetch manifest for release:", release, error);
			return null;
		}
	}

	public getNewRelease(): Release | undefined {
		const release = this.releaseChannels.get(
			this.releaseSettings.get().channel,
		);
		if (!release) {
			return;
		}
		if (updateAvailable(release.tag_name, this.plugin.version)) {
			return release;
		}
	}

	public async installUpdate(release: Release): Promise<boolean> {
		const manifest = await this.fetchReleaseManifest(release);
		try {
			this.debug(
				`Installing update from v${this.plugin.version} to v${manifest.version}...`,
				manifest,
			);

			await this.plugin.app.plugins.installPlugin(
				REPOSITORY,
				manifest.version,
				manifest,
			);

			this.notifyListeners();

			this.debug("Update complete. Reloading plugin...");

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

	override destroy(): void {
		// Stop periodic update checking
		this.stop();

		// Set state to null before destroying
		this.githubReleases = null as any;
		this.releaseChannels = null as any;

		// Let the parent class handle its own cleanup
		super.destroy();
	}
}
