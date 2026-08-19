import type { TimeProvider } from "../TimeProvider";
import { fileName, RetryableProviderSyncError } from "./errors";

/** How long a connected session may take to reach synced. */
const SYNC_TIMEOUT_MS = 10_000;

export interface ProviderSessionFile {
	readonly path: string;
	readonly guid: string;
	connect(): Promise<boolean>;
	onceProviderSynced(): Promise<unknown>;
}

export type ProviderSessionOutcome = "synced" | "cancelled";

/**
 * Drive a file's provider session to synced: connect, then wait for the
 * provider's synced signal — connected does not imply synced, and the
 * fast-path resolves immediately when it already is. A timeout keeps a
 * dropped connection from wedging the caller; cancellation is polled so a
 * cancelled unit of work stands down at this boundary too.
 *
 * Resolves "cancelled" when the caller's cancellation fired; throws a
 * retryable error when the connection was not ready, the sync failed, or
 * the sync timed out. The caller owns whatever it set up around the
 * session and tears it down on every exit (see `finally` at the call site).
 */
export async function awaitProviderSession(
	file: ProviderSessionFile,
	options: {
		timeProvider: TimeProvider;
		isCancelled(): boolean;
		warn(message: string): void;
		errorMessage(error: unknown): string;
	},
): Promise<ProviderSessionOutcome> {
	const { timeProvider, isCancelled } = options;
	const connected = await file.connect();
	if (!connected) {
		if (isCancelled()) return "cancelled";
		throw new RetryableProviderSyncError(
			`Provider connection is not ready for ${fileName(file.path)}`,
		);
	}
	if (isCancelled()) return "cancelled";

	let timerId: number | undefined;
	let cancelTimerId: number | undefined;
	let providerSyncFailure: unknown;
	const synced = await Promise.race([
		file.onceProviderSynced().then(
			() => true,
			(e) => {
				providerSyncFailure = e;
				return false;
			},
		),
		new Promise<false>((resolve) => {
			timerId = timeProvider.setTimeout(() => resolve(false), SYNC_TIMEOUT_MS);
		}),
		new Promise<false>((resolve) => {
			cancelTimerId = timeProvider.setInterval(() => {
				if (isCancelled()) resolve(false);
			}, 100);
		}),
	]);
	if (timerId !== undefined) timeProvider.clearTimeout(timerId);
	if (cancelTimerId !== undefined) timeProvider.clearInterval(cancelTimerId);
	if (synced) return "synced";

	if (isCancelled()) return "cancelled";
	if (providerSyncFailure) {
		options.warn(
			`[providerSession] provider sync failed: ${file.path} guid=${file.guid}: ${options.errorMessage(providerSyncFailure)}`,
		);
		throw new RetryableProviderSyncError(
			`Provider sync is not ready for ${fileName(file.path)}: ${options.errorMessage(providerSyncFailure)}`,
			providerSyncFailure,
		);
	}
	options.warn(
		`[providerSession] provider sync timed out: ${file.path} guid=${file.guid}`,
	);
	throw new RetryableProviderSyncError(
		`Provider sync timed out for ${fileName(file.path)}`,
	);
}
