/**
 * Type declarations for the TSDB API
 *
 * Copy this file into your plugin to get type-safe access to the metrics API.
 *
 * ## Accessing the API
 *
 * Access via the plugin instance:
 * ```typescript
 * const metricsPlugin = this.app.plugins.plugins['tsdb'] as ObsidianMetricsPlugin | undefined;
 * const api = metricsPlugin?.api;
 * ```
 *
 * ## Handling Plugin Load Order
 *
 * The TSDB plugin emits 'tsdb:ready' when loaded. Listen for this
 * event to handle cases where your plugin loads before TSDB:
 *
 * ```typescript
 * class MyPlugin extends Plugin {
 *   private metricsApi: IObsidianMetricsAPI | undefined;
 *   private documentGauge: MetricInstance | undefined;
 *
 *   async onload() {
 *     // Listen for metrics API becoming available (or re-initializing after reload)
 *     this.registerEvent(
 *       this.app.workspace.on('tsdb:ready', (api: IObsidianMetricsRootAPI) => {
 *         this.initializeMetrics(api);
 *       })
 *     );
 *
 *     // Also try to get it immediately in case metrics plugin loaded first
 *     const metricsPlugin = this.app.plugins.plugins['tsdb'] as ObsidianMetricsPlugin | undefined;
 *     if (metricsPlugin?.api) {
 *       this.initializeMetrics(metricsPlugin.api);
 *     }
 *   }
 *
 *   private initializeMetrics(rootApi: IObsidianMetricsRootAPI) {
 *     const api = rootApi.getStore('my-plugin');
 *     this.metricsApi = api;
 *     // Metric creation is idempotent - safe to call multiple times
 *     this.documentGauge = api.createGauge({
 *       name: 'my_document_size_bytes',
 *       help: 'Size of documents in bytes',
 *       labelNames: ['document']
 *     });
 *   }
 *
 *   updateDocumentSize(doc: string, bytes: number) {
 *     this.documentGauge?.labels({ document: doc }).set(bytes);
 *   }
 * }
 * ```
 *
 * ## Key Points
 *
 * - **Do NOT cache the API or metrics long-term** - they become stale if TSDB reloads
 * - Listen for 'tsdb:ready' and re-initialize your metrics each time it fires
 * - Metric creation is idempotent: calling createGauge() with the same name returns the existing metric
 * - It's safe to store metric references within an initialization cycle, but always re-create them
 *   when 'tsdb:ready' fires
 */

export interface MetricLabels {
	[key: string]: string;
}

export interface CounterOptions {
	name: string;
	help: string;
	labelNames?: string[];
}

export interface GaugeOptions {
	name: string;
	help: string;
	labelNames?: string[];
}

export interface HistogramOptions {
	name: string;
	help: string;
	labelNames?: string[];
	buckets?: number[];
}

export interface SummaryOptions {
	name: string;
	help: string;
	labelNames?: string[];
	percentiles?: number[];
	maxAgeSeconds?: number;
	ageBuckets?: number;
}

export interface LabeledMetricInstance {
	inc(value?: number): void;
	dec(value?: number): void;
	set(value: number): void;
	observe(value: number): void;
	startTimer(): () => void;
}

export interface MetricInstance {
	inc(value?: number, labels?: MetricLabels): void;
	dec(value?: number, labels?: MetricLabels): void;
	set(value: number, labels?: MetricLabels): void;
	observe(value: number, labels?: MetricLabels): void;
	startTimer(labels?: MetricLabels): () => void;
	labels(labels: MetricLabels): LabeledMetricInstance;
}

/**
 * The root API exposed as plugin.api and via 'tsdb:ready'.
 * All metrics live inside a named store, recorded into the local TSDB at
 * the store's own frequency (job label = store name).
 *
 * @example
 * const store = api.getStore('my-plugin', { intervalSeconds: 1 });
 * const counter = store.createCounter({ name: 'my_ops_total', help: '...' });
 */
export interface IObsidianMetricsRootAPI {
	/**
	 * Get or create a named metric store (idempotent per name).
	 * `displayName` and `description` are shown in the plugin's settings
	 * under your store's section — say briefly what you record.
	 */
	getStore(
		name: string,
		options?: {
			intervalSeconds?: number;
			displayName?: string;
			description?: string;
		},
	): IObsidianMetricsAPI;
}

export interface IObsidianMetricsAPI {
	// Metric retrieval
	getMetric(name: string): MetricInstance | undefined;
	getAllMetrics(): Promise<string>;
	clearMetric(name: string): boolean;
	clearAllMetrics(): void;

	// Metric creation (idempotent - returns existing metric if name matches)
	createCounter(options: CounterOptions): MetricInstance;
	createGauge(options: GaugeOptions): MetricInstance;
	createHistogram(options: HistogramOptions): MetricInstance;
	createSummary(options: SummaryOptions): MetricInstance;

	// Convenience methods (create + optional initial value)
	counter(name: string, help: string, value?: number): MetricInstance;
	gauge(name: string, help: string, value?: number): MetricInstance;
	histogram(name: string, help: string, buckets?: number[]): MetricInstance;
	summary(name: string, help: string, percentiles?: number[]): MetricInstance;

	// Timing utilities
	createTimer(metricName: string): () => number;
	measureAsync<T>(metricName: string, fn: () => Promise<T>): Promise<T>;
	measureSync<T>(metricName: string, fn: () => T): T;
}

/** Type for the TSDB plugin instance */
export interface ObsidianMetricsPlugin {
	api: IObsidianMetricsRootAPI;
}

/** Augment Obsidian's workspace events to include our custom event */
declare module "obsidian" {
	interface Workspace {
		on(
			name: "tsdb:ready",
			callback: (api: IObsidianMetricsRootAPI) => void,
		): EventRef;
		trigger(name: "tsdb:ready", api: IObsidianMetricsRootAPI): void;
	}
}
