"use strict";

import { TextFileView, type Workspace } from "obsidian";
import { HasLogging } from "./debug";
import type { NamespacedSettings } from "./SettingsStorage";

/**
 * The text-file view types Relay always drives live edits into, independent
 * of any plugin registration.
 */
const ALLOWED_TEXT_FILE_VIEWS = ["markdown", "kanban"];

/** One persisted registration: a view type and the API version that wrote it. */
export interface StoredViewRegistration {
	viewType: string;
	version: number;
}

/** The per-plugin block persisted under `plugins.<pluginId>`. */
export interface PluginRegistrationBlock {
	views?: StoredViewRegistration[];
	[key: string]: unknown;
}

/** Everything persisted under the `plugins` settings key, keyed by plugin id. */
export type PluginRegistrationSettings = Record<
	string,
	PluginRegistrationBlock
>;

/**
 * The set of view types Relay drives live edits into.
 *
 * Seeded with the built-in types; plugins extend it at runtime through the
 * public API. Registrations persist in the settings file so that a leaf
 * restored on cold start attaches before its plugin has had a chance to call
 * in — leaves are enumerated as folders connect, with no guarantee a
 * consumer's own startup has run by then.
 */
export class TextViewRegistry extends HasLogging {
	/** View types applied per plugin id: live registrations and loaded rows. */
	private applied = new Map<string, Set<string>>();
	/** The set the leaf iterator consults; rebuilt when registrations change. */
	private allowed = new Set(ALLOWED_TEXT_FILE_VIEWS);
	/** Serializes persistence writes so registrations cannot race each other. */
	private writes: Promise<void> = Promise.resolve();
	/** Makes release handles inert once the registry's owner unloads. */
	private destroyed = false;

	constructor(
		private settings: NamespacedSettings<PluginRegistrationSettings>,
	private resolvesViewType: (viewType: string) => boolean | undefined,
	) {
		super();
	}

	/** Whether Relay drives live edits into this view type. O(1). */
	has(viewType: string): boolean {
		return this.allowed.has(viewType);
	}

	/**
	 * Register a view type for live editing and persist the registration.
	 * Registration is idempotent per (plugin, type).
	 */
	register(
		pluginId: string,
		viewType: string,
		version: number,
	): void {
		const id = typeof pluginId === "string" ? pluginId.trim() : "";
		const type = typeof viewType === "string" ? viewType.trim() : "";
		if (!id || !type) {
			throw new Error("registerTextView requires a plugin id and a view type");
		}
		if (this.destroyed) return;
		this.apply(id, type);
		this.persist((current) => upsertRegistration(current, id, type, version));
	}

	/** Remove one persisted registration. Idempotent per (plugin, type). */
	unregister(pluginId: string, viewType: string): void {
		const id = typeof pluginId === "string" ? pluginId.trim() : "";
		const type = typeof viewType === "string" ? viewType.trim() : "";
		if (!id || !type) {
			throw new Error("unregisterTextView requires a plugin id and a view type");
		}
		if (this.destroyed) return;
		this.unapply(id, type);
		this.persist((current) => removeRegistration(current, id, type));
	}

	/** Release live registrations and make outstanding handles inert. */
	destroy(): void {
		this.destroyed = true;
		this.applied.clear();
		this.rebuild();
	}

	/**
	 * Apply the persisted registrations. Called once at startup, before shared
	 * folders connect, so restored leaves attach on cold start without waiting
	 * for their plugin. By this point every enabled plugin has registered its
	 * view factories, so a row is applied only while its view type resolves in
	 * the app's view registry; rows that no longer resolve — the plugin was
	 * disabled or uninstalled — are pruned, and a plugin block with nothing
	 * left in it is dropped. A plugin that comes back re-registers on its own
	 * startup, so pruning is self-healing.
	 */
	load(): void {
		const stored = this.settings.get() ?? {};
		let needsPrune = false;
		for (const [pluginId, block] of Object.entries(stored)) {
			const views = Array.isArray(block?.views) ? block.views : [];
			if (views.length === 0) {
				needsPrune = true;
				continue;
			}
			for (const row of views) {
				const type =
					typeof row?.viewType === "string" ? row.viewType.trim() : "";
				if (!type) {
					needsPrune = true;
					continue;
				}
				if (this.applied.get(pluginId)?.has(type)) {
					continue;
				}
				const resolution = this.resolveViewType(type);
				if (resolution === true) {
					this.apply(pluginId, type);
				} else if (resolution === false) {
					this.log(
						`pruning persisted view registration ${pluginId}/${type}: view type no longer resolves`,
					);
					needsPrune = true;
				} else {
					this.log(
						`keeping persisted view registration ${pluginId}/${type}: view registry probe unavailable`,
					);
				}
			}
		}
		if (needsPrune) {
			this.persist((current) => this.pruneStale(current));
		}
	}

	/** Resolves when every enqueued persistence write has settled. */
	flush(): Promise<void> {
		return this.writes;
	}

	private apply(pluginId: string, viewType: string): void {
		let types = this.applied.get(pluginId);
		if (!types) {
			types = new Set();
			this.applied.set(pluginId, types);
		}
		types.add(viewType);
		this.rebuild();
	}

	private unapply(pluginId: string, viewType: string): void {
		const types = this.applied.get(pluginId);
		if (!types) return;
		types.delete(viewType);
		if (types.size === 0) {
			this.applied.delete(pluginId);
		}
		this.rebuild();
	}

	private rebuild(): void {
		const next = new Set(ALLOWED_TEXT_FILE_VIEWS);
		for (const types of this.applied.values()) {
			for (const viewType of types) {
				next.add(viewType);
			}
		}
		this.allowed = next;
	}

	private resolveViewType(viewType: string): boolean | undefined {
		try {
			return this.resolvesViewType(viewType);
		} catch (error) {
			this.log("keeping persisted view registrations: view registry probe failed", error);
			return undefined;
		}
	}

	/**
	 * Drop rows that neither resolve nor are held by a live registration, and
	 * blocks left with nothing in them. Evaluated when the write runs, against
	 * the data as it is then, so a registration enqueued in the meantime is
	 * never swept away.
	 */
	private pruneStale(
		current: PluginRegistrationSettings,
	): PluginRegistrationSettings {
		const next: PluginRegistrationSettings = {};
		for (const [pluginId, block] of Object.entries(current)) {
			const views = Array.isArray(block?.views) ? block.views : [];
			const kept = views.filter((row) => {
				const type =
					typeof row?.viewType === "string" ? row.viewType.trim() : "";
				if (!type) return false;
				return (
					this.applied.get(pluginId)?.has(type) === true ||
					this.resolveViewType(type) !== false
				);
			});
			const rest = { ...block };
			delete rest.views;
			if (kept.length > 0) rest.views = kept;
			if (Object.keys(rest).length > 0) next[pluginId] = rest;
		}
		return next;
	}

	private persist(
		mutate: (
			current: PluginRegistrationSettings,
		) => PluginRegistrationSettings,
	): void {
		this.writes = this.writes
			.then(async () => {
				const current = this.settings.get() ?? {};
				const next = mutate(current);
				if (JSON.stringify(next) === JSON.stringify(current)) return;
				if (Object.keys(next).length === 0) {
					if (this.settings.exists()) {
						await this.settings.delete();
					}
					return;
				}
				await this.settings.set(next);
			})
			.catch((error) => {
				this.warn("failed to persist view registrations", error);
			});
	}
}

function upsertRegistration(
	current: PluginRegistrationSettings,
	pluginId: string,
	viewType: string,
	version: number,
): PluginRegistrationSettings {
	const block = current[pluginId] ?? {};
	const views = Array.isArray(block.views) ? block.views : [];
	const kept = views.filter((row) => row?.viewType !== viewType);
	kept.push({ viewType, version });
	return { ...current, [pluginId]: { ...block, views: kept } };
}

function removeRegistration(
	current: PluginRegistrationSettings,
	pluginId: string,
	viewType: string,
): PluginRegistrationSettings {
	const block = current[pluginId];
	if (!block) return current;
	const views = Array.isArray(block.views) ? block.views : [];
	const kept = views.filter((row) => row?.viewType !== viewType);
	if (kept.length === views.length) return current;
	if (kept.length > 0) {
		return { ...current, [pluginId]: { ...block, views: kept } };
	}
	const rest = { ...block };
	delete rest.views;
	if (Object.keys(rest).length > 0) {
		return { ...current, [pluginId]: rest };
	}
	const next = { ...current };
	delete next[pluginId];
	return next;
}

/**
 * Visit every open text-file view Relay should drive live edits into:
 * instances of TextFileView whose view type is in the registry. Canvas has
 * its own pipeline and is excluded here.
 */
export function iterateTextFileViews(
	workspace: Workspace,
	registry: TextViewRegistry,
	fn: (view: TextFileView) => void,
): void {
	workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof TextFileView) {
			const viewType = leaf.view.getViewType();
			if (viewType === "canvas") return;
			if (registry.has(viewType)) {
				fn(leaf.view);
			}
		}
	});
}
