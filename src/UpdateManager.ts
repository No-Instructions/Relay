import { Plugin } from "obsidian";
import type { TimeProvider } from "./TimeProvider";
import { Observable } from "./observable/Observable";
import { customFetch } from "./customFetch";
import { LocalStorage } from "./LocalStorage";
import type { NamespacedSettings } from "./SettingsStorage";
import { flags } from "./flagManager";

declare const REPOSITORY: string;

export type PluginWithVersion = Plugin & { version: string };

export interface Release {
	tag_name: string;
	prerelease: boolean;
	draft: boolean;
	created_at: string;
	html_url?: string;
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
	private updateGeneration: number = 0;
	observableName = "UpdateManager";

	constructor(
		private plugin: PluginWithVersion,
		private timeProvider: TimeProvider,
		private releaseSettings: NamespacedSettings<ReleaseSettings>,
	) {
		super("UpdateManager");
		this.githubReleases = new LocalStorage("system3-relay/releases");
		this.releaseChannels = new LocalStorage("system3-relay/releaseChannels");
	}

	public get releases(): Release[] {
		if (this.destroyed) {
			return [];
		}
		return [...this.githubReleases.values()].sort((a, b) =>
			b.tag_name.localeCompare(a.tag_name, undefined, {
				numeric: true,
				sensitivity: "base",
			}),
		);
	}

	public get beta(): Release | undefined {
		if (this.destroyed) {
			return undefined;
		}
		return this.releaseChannels.get("beta");
	}

	public get stable(): Release | undefined {
		if (this.destroyed) {
			return undefined;
		}
		return this.releaseChannels.get("stable");
	}

	private isActiveGeneration(generation: number): boolean {
		return !this.destroyed && generation === this.updateGeneration;
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
		if (this.destroyed) {
			return null;
		}
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
		const generation = this.updateGeneration;
		if (!this.isActiveGeneration(generation)) {
			return [];
		}
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
			if (!this.isActiveGeneration(generation)) {
				return [];
			}
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
			if (!this.isActiveGeneration(generation)) {
				return [];
			}
			if (latest) {
				latest.latest = true;
				this.githubReleases.set(latest.tag_name, latest);
			}

			// Notify subscribers that we have new releases data
			this.notifyListeners();
		} catch (error) {
			if (this.isActiveGeneration(generation)) {
				this.error("Failed to fetch GitHub releases:", error);
			}
		}
		if (!this.isActiveGeneration(generation)) {
			return [];
		}
		return [...this.githubReleases.values()];
	}

	private async getChannelRelease(): Promise<Release | null> {
		const generation = this.updateGeneration;
		if (!this.isActiveGeneration(generation)) {
			return null;
		}
		const now = Date.now();
		const channelRelease = this.releaseChannels.get(
			this.releaseSettings.get().channel,
		);
		if (now - this.lastChannelCheck < 5 * 60 * 1000 && channelRelease) {
			return channelRelease;
		}
		this.lastReleaseCheck = now;

		const releases = await this.getReleases();
		if (!this.isActiveGeneration(generation)) {
			return null;
		}
		if (releases.length === 0) {
			this.debug("No releases found");
			return null;
		}

		const channel = this.releaseSettings.get().channel;
		if (!channel) return null;

		const version = await this.fetchLatestTagFromChannel(channel);
		if (!this.isActiveGeneration(generation)) {
			return null;
		}
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
		const generation = this.updateGeneration;
		await this.getReleases();
		if (!this.isActiveGeneration(generation)) {
			return;
		}
		await this.getChannelRelease();
	}

	public start(): void {
		if (this.destroyed) {
			return;
		}
		this.updateGeneration += 1;
		void this.update();
		this.updateCheckInterval = this.timeProvider.setInterval(
			() => void this.update(),
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

	public findReleaseByVersion(versionOrTag: string): Release | undefined {
		if (this.destroyed) {
			return undefined;
		}
		const version = normalizeVersion(versionOrTag);
		return [...this.githubReleases.values()].find((release) => {
			return normalizeVersion(release.tag_name) === version;
		});
	}

	public getReleaseUrl(release?: Release | string): string {
		const releasesUrl = `https://github.com/${REPOSITORY}/releases`;
		if (!release) {
			return releasesUrl;
		}
		if (typeof release !== "string" && release.html_url) {
			return release.html_url;
		}
		const tagName = typeof release === "string" ? release : release.tag_name;
		return `${releasesUrl}/tag/${encodeURIComponent(tagName)}`;
	}

	override destroy(): void {
		if (this.destroyed) {
			return;
		}
		// Stop periodic update checking
		this.stop();
		this.updateGeneration += 1;

		// Set state to null before destroying
		this.githubReleases = null as any;
		this.releaseChannels = null as any;

		// Let the parent class handle its own cleanup
		super.destroy();
	}
}
