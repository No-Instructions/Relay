import * as Y from "yjs";
import type { Canvas } from "../Canvas";
import { HasLogging } from "../debug";
import { isEmptyDoc } from "../merge-hsm/snapshots";
import { formatUserFacingError } from "../UserFacingError";
import { fileName, isRetryableSyncError } from "./errors";
import { awaitProviderSession } from "./providerSession";
import type { SessionIntent, SyncOperationContext } from "./SyncParticipant";

/**
 * How a canvas performs its background work. A canvas has no upload
 * preparation and no merge base to recover: every session is a provider
 * session driven to synced, and a transfer lands the server's full state on
 * the provider-facing replica for the bridge and the machine to take from
 * there. The machine hears about it only through the shared signals.
 */
export class CanvasSyncAdapter extends HasLogging {
	constructor(private readonly canvas: Canvas) {
		super("CanvasSync");
	}

	acceptsSession(): boolean {
		return true;
	}

	async runSession(
		_intent: SessionIntent,
		context: SyncOperationContext,
	): Promise<void> {
		const canvas = this.canvas;
		if (canvas.destroyed) return;
		try {
			const synced = await this.runProviderSession(context);
			if (!synced) {
				if (context.isCancelled()) return;
				throw new Error(`Unable to sync ${fileName(canvas.path)}`);
			}
		} catch (e) {
			if (!isRetryableSyncError(e)) {
				this.logError("[session] failed", e);
			}
			throw e;
		}
	}

	/**
	 * Drive the canvas's provider session to synced and deliver
	 * PROVIDER_SYNCED. Canvas activeness is the view lock alone: a session
	 * no view holds is released on the way out, whether this operation
	 * opened it or found it open. Resolves false when the work was cancelled.
	 */
	private async runProviderSession(
		context: SyncOperationContext,
	): Promise<boolean> {
		const canvas = this.canvas;
		if (canvas.destroyed) return false;
		this.log(
			`[session] start: ${canvas.path} guid=${canvas.guid} intent=${canvas.intent} connected=${canvas.connected}`,
		);
		if (context.isCancelled()) return false;
		const sharedFolder = canvas.sharedFolder;
		const shouldReleaseSession = () =>
			!(canvas.userLock || sharedFolder?.mergeManager?.isActive(canvas.guid));

		let outcome: "synced" | "cancelled";
		try {
			outcome = await awaitProviderSession(canvas, {
				timeProvider: context.timeProvider,
				isCancelled: () => context.isCancelled(),
				warn: (message) => this.warn(message),
				errorMessage: (error) => this.errorMessage(error),
			});
			if (outcome === "synced") {
				// A session reaching synced means the same thing to every
				// machine.
				canvas.hsm.send({ type: "PROVIDER_SYNCED" });
			}
		} finally {
			if (shouldReleaseSession()) {
				canvas.releaseIdleSession();
			}
		}
		return outcome === "synced";
	}

	async transfer(
		_context: SyncOperationContext,
	): Promise<Uint8Array | undefined> {
		const canvas = this.canvas;
		if (canvas.sharedFolder.serverEmptyTerminal(canvas.guid)) {
			this.debug(
				`[transfer] skipped ${canvas.path}: server has no content for guid; awaiting server evidence`,
			);
			canvas.hsm.send({ type: "DOWNLOAD_FAILED" });
			return undefined;
		}
		try {
			const response = await canvas.sharedFolder.backgroundSync.downloadItem(canvas);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			// A guid that is registered but never uploaded downloads as an
			// empty doc; defer instead of reporting a contentless download
			// as complete. Enrolled canvases always carry the header op, so
			// only truly never-uploaded content defers.
			const peekDoc = new Y.Doc();
			Y.applyUpdate(peekDoc, updateBytes);
			const serverEmpty = isEmptyDoc(peekDoc);
			peekDoc.destroy();
			if (serverEmpty) {
				canvas.sharedFolder.recordServerEmpty(canvas.guid);
				this.log(
					"[transfer] server has guid registered but no content",
					canvas.path,
				);
				canvas.hsm.send({ type: "DOWNLOAD_FAILED" });
				return undefined;
			}

			this.log("[transfer] applying content from server");
			// Server content lands on the provider-facing remoteDoc; the
			// CanvasDocBridge merges it into the localDoc, and the canvas's
			// machine decides whether disk follows. The canvas must be warm
			// first — on a hibernated canvas the update would land on a
			// bridge-less remoteDoc, and a later re-download of the same ops
			// produces no update events to recover it.
			canvas.wake();
			Y.applyUpdate(canvas.ydoc, updateBytes);
			// A full-state download is the canvas keyframe: seed the
			// applied-remote baseline so later folder events classify
			// against it instead of gapping once per session.
			canvas.sharedFolder.mergeManager?.seedAppliedRemoteUpdate(
				canvas.guid,
				updateBytes,
			);
			canvas.hsm.send({ type: "DOWNLOAD_COMPLETE" });
			return updateBytes;
		} catch (e) {
			this.logError("[transfer] failed", e);
			canvas.hsm.send({ type: "DOWNLOAD_FAILED" });
			throw e;
		}
	}

	private errorMessage(error: unknown): string {
		return formatUserFacingError(error);
	}

	private logError(context: string, error: unknown): void {
		this.error(`${context}: ${this.errorMessage(error)}`, error);
	}
}
