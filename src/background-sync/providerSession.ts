import type { TimeProvider } from "../TimeProvider";
import { OutboundRejectedError } from "../client/provider";
import { fileName, RetryableProviderSyncError } from "./errors";

/** How long a connected session may take to reach synced. */
const SYNC_TIMEOUT_MS = 10_000;

/**
 * How long a synced session may wait for the server to acknowledge the
 * writes the handshake carried.
 */
const ACK_TIMEOUT_MS = 10_000;

export interface ProviderSessionFile {
	readonly path: string;
	readonly guid: string;
	connect(): Promise<boolean>;
	onceProviderSynced(): Promise<unknown>;
	/** Writes sent through the provider that the server has not acknowledged. */
	readonly hasUnackedChanges?: boolean;
	/** Resolves once the server has processed every write sent so far. */
	whenAcked?(): Promise<void>;
}

export type ProviderSessionOutcome = "synced" | "cancelled";

type StepResult =
	| { kind: "done" }
	| { kind: "timeout" }
	| { kind: "cancelled" }
	| { kind: "failed"; error: unknown };

/**
 * Await one step of the session under a deadline, polling cancellation.
 * Never throws: the caller classifies the result.
 */
async function awaitStep(
	step: Promise<unknown>,
	deadlineMs: number,
	timeProvider: TimeProvider,
	isCancelled: () => boolean,
): Promise<StepResult> {
	let timerId: number | undefined;
	let cancelTimerId: number | undefined;
	try {
		return await Promise.race<StepResult>([
			step.then(
				() => ({ kind: "done" }),
				(error: unknown) => ({ kind: "failed", error }),
			),
			new Promise<StepResult>((resolve) => {
				timerId = timeProvider.setTimeout(
					() => resolve({ kind: "timeout" }),
					deadlineMs,
				);
			}),
			new Promise<StepResult>((resolve) => {
				cancelTimerId = timeProvider.setInterval(() => {
					if (isCancelled()) resolve({ kind: "cancelled" });
				}, 100);
			}),
		]);
	} finally {
		if (timerId !== undefined) timeProvider.clearTimeout(timerId);
		if (cancelTimerId !== undefined) timeProvider.clearInterval(cancelTimerId);
	}
}

/**
 * Drive a file's provider session to synced and acknowledged: connect, wait
 * for the provider's synced signal — connected does not imply synced, and
 * the fast-path resolves immediately when it already is — then, when the
 * handshake carried writes, wait for the server's acknowledgement of them.
 * Deadlines keep a dropped connection from wedging the caller; cancellation
 * is polled so a cancelled unit of work stands down at this boundary too.
 *
 * Resolves "cancelled" when the caller's cancellation fired; throws a
 * retryable error when the connection was not ready, the sync or the
 * acknowledgement failed, or either timed out. A refused write throws the
 * provider's OutboundRejectedError, which is not retryable: the server will
 * not take those ops until the remote replica is rebuilt. The caller owns
 * whatever it set up around the session and tears it down on every exit
 * (see `finally` at the call site).
 */
export async function awaitProviderSession(
	file: ProviderSessionFile,
	options: {
		timeProvider: TimeProvider;
		isCancelled: () => boolean;
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

	const synced = await awaitStep(
		file.onceProviderSynced(),
		SYNC_TIMEOUT_MS,
		timeProvider,
		isCancelled,
	);
	switch (synced.kind) {
		case "cancelled":
			return "cancelled";
		case "failed":
			if (isCancelled()) return "cancelled";
			options.warn(
				`[providerSession] provider sync failed: ${file.path} guid=${file.guid}: ${options.errorMessage(synced.error)}`,
			);
			throw new RetryableProviderSyncError(
				`Provider sync is not ready for ${fileName(file.path)}: ${options.errorMessage(synced.error)}`,
				synced.error,
			);
		case "timeout":
			if (isCancelled()) return "cancelled";
			options.warn(
				`[providerSession] provider sync timed out: ${file.path} guid=${file.guid}`,
			);
			throw new RetryableProviderSyncError(
				`Provider sync timed out for ${fileName(file.path)}`,
			);
		case "done":
			break;
	}

	if (!file.hasUnackedChanges || !file.whenAcked) {
		return "synced";
	}

	const acked = await awaitStep(
		file.whenAcked(),
		ACK_TIMEOUT_MS,
		timeProvider,
		isCancelled,
	);
	switch (acked.kind) {
		case "cancelled":
			return "cancelled";
		case "failed":
			if (isCancelled()) return "cancelled";
			if (acked.error instanceof OutboundRejectedError) {
				options.warn(
					`[providerSession] server refused writes: ${file.path} guid=${file.guid}: ${acked.error.reason}`,
				);
				throw acked.error;
			}
			options.warn(
				`[providerSession] provider acknowledgement failed: ${file.path} guid=${file.guid}: ${options.errorMessage(acked.error)}`,
			);
			throw new RetryableProviderSyncError(
				`Provider acknowledgement failed for ${fileName(file.path)}: ${options.errorMessage(acked.error)}`,
				acked.error,
			);
		case "timeout":
			if (isCancelled()) return "cancelled";
			options.warn(
				`[providerSession] provider acknowledgement timed out: ${file.path} guid=${file.guid}`,
			);
			throw new RetryableProviderSyncError(
				`Provider acknowledgement timed out for ${fileName(file.path)}`,
			);
		case "done":
			return "synced";
	}
}
