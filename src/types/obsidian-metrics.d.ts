/**
 * Type declarations for the Obsidian Metrics API
 *
 * Copy this file into your plugin to get type-safe access to the metrics API.
 *
 * ## Accessing the API
 *
 * Access via the plugin instance:
 * ```typescript
 * const metricsPlugin = this.app.plugins.plugins['obsidian-metrics'] as ObsidianMetricsPlugin | undefined;
 * const api = metricsPlugin?.api;
 * ```
 *
 * ## Handling Plugin Load Order
 *
 * The metrics plugin emits 'obsidian-metrics:ready' when loaded. Listen for this
 * event to handle cases where your plugin loads before obsidian-metrics:
 *
 * ```typescript
 * class MyPlugin extends Plugin {
 *   private metricsApi: IObsidianMetricsAPI | undefined;
 *   private documentGauge: MetricInstance | undefined;
 *
 *   async onload() {
 *     // Listen for metrics API becoming available (or re-initializing after reload)
 *     this.registerEvent(
 *       this.app.workspace.on('obsidian-metrics:ready', (api: IObsidianMetricsAPI) => {
 *         this.initializeMetrics(api);
 *       })
 *     );
 *
 *     // Also try to get it immediately in case metrics plugin loaded first
 *     const metricsPlugin = this.app.plugins.plugins['obsidian-metrics'] as ObsidianMetricsPlugin | undefined;
 *     if (metricsPlugin?.api) {
 *       this.initializeMetrics(metricsPlugin.api);
 *     }
 *   }
 *
 *   private initializeMetrics(api: IObsidianMetricsAPI) {
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
 * - **Do NOT cache the API or metrics long-term** - they become stale if obsidian-metrics reloads
 * - Listen for 'obsidian-metrics:ready' and re-initialize your metrics each time it fires
 * - Metric creation is idempotent: calling createGauge() with the same name returns the existing metric
 * - It's safe to store metric references within an initialization cycle, but always re-create them
 *   when 'obsidian-metrics:ready' fires
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

/** Type for the obsidian-metrics plugin instance */
export interface ObsidianMetricsPlugin {
	api: IObsidianMetricsAPI;
}

/** Augment Obsidian's workspace events to include our custom event */
declare module 'obsidian' {
	interface Workspace {
		on(name: 'obsidian-metrics:ready', callback: (api: IObsidianMetricsAPI) => void): EventRef;
		trigger(name: 'obsidian-metrics:ready', api: IObsidianMetricsAPI): void;
	}
}
