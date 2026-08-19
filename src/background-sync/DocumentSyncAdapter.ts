import * as Y from "yjs";
import type { Document } from "../Document";
import { HasLogging } from "../debug";
import { isEmptyDoc } from "../merge-hsm/snapshots";
import { S3RN } from "../S3RN";
import { formatUserFacingError } from "../UserFacingError";
import {
	fileName,
	isRetryableSyncError,
	RetryableProviderSyncError,
} from "./errors";
import { awaitProviderSession } from "./providerSession";
import type { SessionIntent, SyncOperationContext } from "./SyncParticipant";

/**
 * How a document performs its background work. The engine dispatches a unit
 * of work here without knowing what a document is; the adapter drives the
 * document's provider session, its merge machine, and the merge manager's
 * residency pool, and speaks to the machine only through the shared signal
 * vocabulary.
 */
export class DocumentSyncAdapter extends HasLogging {
	constructor(private readonly doc: Document) {
		super("DocumentSync");
	}

	/** A document parked in conflict is moved only by its resolution surface. */
	acceptsSession(): boolean {
		return this.doc.hsm?.getSyncStatus().status !== "conflict";
	}

	async runSession(
		intent: SessionIntent,
		context: SyncOperationContext,
	): Promise<void> {
		switch (intent) {
			case "upload":
				return this.upload(context);
			case "backfill":
				return this.backfillMergeBase(context);
			default:
				return this.converge(context);
		}
	}

	// =========================================================================
	// Converge: a background provider session
	// =========================================================================

	private async converge(context: SyncOperationContext): Promise<void> {
		const doc = this.doc;
		if (doc.destroyed) return;
		if (!this.acceptsSession()) return;
		try {
			const synced = await this.runProviderSession(context);
			if (!synced) {
				if (context.isCancelled()) return;
				throw new Error(`Unable to sync ${fileName(doc.path)}`);
			}
		} catch (e) {
			if (!isRetryableSyncError(e)) {
				this.logError("[converge] failed", e);
			}
			throw e;
		}
	}

	/**
	 * Open (or borrow) a provider session for the document, wait for it to
	 * reach synced, establish the merge base if the document has none, and
	 * deliver PROVIDER_SYNCED. A session this operation opened itself is
	 * released on the way out unless a user surface took the document
	 * meanwhile. Resolves false when the work was cancelled.
	 */
	private async runProviderSession(
		context: SyncOperationContext,
	): Promise<boolean> {
		const doc = this.doc;
		if (doc.destroyed) return false;
		this.log(
			`[session] start: ${doc.path} guid=${doc.guid} intent=${doc.intent} connected=${doc.connected}`,
		);
		if (context.isCancelled()) return false;
		const sharedFolder = doc.sharedFolder;
		const refreshQueueKey = S3RN.encode(doc.s3rn);
		const isActive =
			doc.userLock || sharedFolder?.mergeManager?.isActive(doc.guid);
		const startedDisconnected = doc.intent === "disconnected";
		const hadProviderIntegration = doc.hasProviderIntegration();
		const acquiredIdleIntegration = !isActive
			? doc.ensureIdleProviderIntegration({
					freshRemoteDoc: !!doc.hsm?.hasFork(),
				})
			: false;
		const shouldCleanupIdleSession = () =>
			startedDisconnected &&
			!(doc.userLock || sharedFolder?.mergeManager?.isActive(doc.guid));
		const cleanupIdleSession = () => {
			if (acquiredIdleIntegration) {
				doc.destroyIdleProviderIntegration();
				if (shouldCleanupIdleSession()) {
					sharedFolder?.tokenStore.removeFromRefreshQueue(refreshQueueKey);
				}
				return;
			}
			if (!shouldCleanupIdleSession()) return;
			if (hadProviderIntegration || doc.hasProviderIntegration()) {
				return;
			}
			doc.releaseIdleSession();
		};
		if (doc.destroyed) return false;

		let outcome: "synced" | "cancelled";
		try {
			outcome = await awaitProviderSession(doc, {
				timeProvider: context.timeProvider,
				isCancelled: () => context.isCancelled(),
				warn: (message) => this.warn(message),
				errorMessage: (error) => this.errorMessage(error),
			});
			if (outcome === "synced") {
				await this.maybeBootstrapMergeBase(context);
				// A session reaching synced means the same thing to every
				// machine; the send is idempotent for documents, whose
				// provider integration already delivered it mid-session.
				doc.hsm?.send({ type: "PROVIDER_SYNCED" });
			}
		} finally {
			if (shouldCleanupIdleSession()) {
				cleanupIdleSession();
			}
		}
		return outcome === "synced";
	}

	// =========================================================================
	// Upload: local state is authoritative
	// =========================================================================

	private async upload(context: SyncOperationContext): Promise<void> {
		const doc = this.doc;
		// The lease from upload preparation must survive the provider session
		// and the final content assert: hibernation mid-upload detaches the
		// remoteDoc, which surfaces as an empty remote after preparation.
		let releaseLease: () => void = () => {};
		try {
			if (doc.hsm) {
				releaseLease = await this.prepareUpload(context);
			}
			await this.converge(context);
			if (doc.hsm) {
				this.assertUploadedRemoteHasContent();
			}
		} finally {
			releaseLease();
		}
	}

	/**
	 * Wake the doc and encode its localDoc into the remoteDoc for upload.
	 * Returns the warm-lease release; the caller holds it until the upload
	 * resolves so hibernation cannot tear the doc down mid-pipeline.
	 */
	async prepareUpload(context: SyncOperationContext): Promise<() => void> {
		const doc = this.doc;
		const hsm = doc.hsm;
		if (!hsm) return () => {};
		if (hsm.hasFork()) {
			throw new Error(`Cannot upload ${fileName(doc.path)} while a fork exists`);
		}

		const remoteDoc = doc.ensureRemoteDoc();
		const mergeManager = doc.sharedFolder.mergeManager;
		let releaseLease: () => void = () => {};
		if (!doc.userLock && !mergeManager?.isActive(doc.guid)) {
			if (mergeManager) {
				const lease = mergeManager.wake(doc.guid, remoteDoc, {
					lease: true,
				});
				if (lease) {
					releaseLease = context.holdLease(lease);
				}
			}
		} else {
			hsm.setRemoteDoc(remoteDoc);
		}
		try {
			await hsm.awaitPersistenceReady();

			if (hsm.hasFork()) {
				throw new Error(`Cannot upload ${fileName(doc.path)} while a fork exists`);
			}
			const localDoc = hsm.getLocalDoc();
			if (!localDoc) {
				throw new RetryableProviderSyncError(
					`Local document is not ready for upload: ${fileName(doc.path)}`,
				);
			}

			Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc), hsm);
			hsm.setRemoteDoc(remoteDoc);
			this.assertUploadedRemoteHasContent();
			return releaseLease;
		} catch (e) {
			releaseLease();
			throw e;
		}
	}

	private assertUploadedRemoteHasContent(): void {
		const doc = this.doc;
		const remoteDoc = doc.hsm?.getRemoteDoc() ?? doc.remoteDocOrNull;
		if (!remoteDoc || isEmptyDoc(remoteDoc)) {
			throw new RetryableProviderSyncError(
				`Remote document is empty after upload preparation: ${fileName(doc.path)}`,
			);
		}
	}

	// =========================================================================
	// Backfill: recover a missing merge base from the server's state
	// =========================================================================

	async backfillMergeBase(context: SyncOperationContext): Promise<void> {
		const doc = this.doc;
		if (doc.destroyed || !this.acceptsSession()) {
			return;
		}

		const hsm = doc.hsm;
		if (!hsm || hsm.state.lca || hsm.isActive() || hsm.hasFork()) {
			return;
		}

		let updateBytes: Uint8Array | undefined;
		try {
			updateBytes = await doc.sharedFolder.backgroundSync.downloadByGuid(
				doc.sharedFolder,
				doc.guid,
				doc.path,
			);
		} catch (error) {
			throw new RetryableProviderSyncError(
				`LCA backfill download failed for ${fileName(doc.path)}: ${this.errorMessage(error)}`,
				error,
			);
		}
		if (!updateBytes) {
			throw new RetryableProviderSyncError(
				`Remote document is empty while backfilling LCA: ${fileName(doc.path)}`,
			);
		}

		const validationDoc = new Y.Doc();
		try {
			Y.applyUpdate(validationDoc, updateBytes);
			if (isEmptyDoc(validationDoc)) {
				throw new RetryableProviderSyncError(
					`Remote document is empty while backfilling LCA: ${fileName(doc.path)}`,
				);
			}
		} finally {
			validationDoc.destroy();
		}

		const remoteDoc = doc.ensureRemoteDoc();
		Y.applyUpdate(remoteDoc, updateBytes, remoteDoc);
		const mergeManager = doc.sharedFolder.mergeManager;
		let releaseLease: () => void = () => {};
		if (mergeManager) {
			const lease = mergeManager.wake(doc.guid, remoteDoc, { lease: true });
			if (lease) {
				releaseLease = context.holdLease(lease);
			}
		} else {
			hsm.setRemoteDoc(remoteDoc);
		}
		try {
			const diskState = await doc.readDiskContent();
			const settled = await hsm.bootstrapLCAFromDisk(diskState);
			if (!settled && hsm.getSyncStatus().status === "pending") {
				if (!hsm.hasPersistenceUserData()) {
					this.debug(
						`[lca-backfill] deferred for ${doc.path}: awaiting local enrollment`,
					);
					return;
				}
				this.debug(
					`[lca-backfill] deferred for ${doc.path}: local or remote state is not ready`,
				);
			}
		} finally {
			releaseLease();
		}
	}

	// =========================================================================
	// Transfer: the server's full state down to the local copy
	// =========================================================================

	async transfer(
		context: SyncOperationContext,
	): Promise<Uint8Array | undefined> {
		const doc = this.doc;
		if (doc.sharedFolder.serverEmptyTerminal(doc.guid)) {
			this.debug(
				`[transfer] skipped ${doc.path}: server has no content for guid; awaiting server evidence`,
			);
			doc.hsm?.send({ type: "DOWNLOAD_FAILED" });
			return undefined;
		}
		try {
			const response = await doc.sharedFolder.backgroundSync.downloadItem(doc);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			// Validate: reject uninitialized documents.
			const newDoc = new Y.Doc();
			Y.applyUpdate(newDoc, updateBytes);

			if (isEmptyDoc(newDoc)) {
				if (doc.text) {
					this.log(
						"[transfer] server CRDT empty, local has content — uploading",
					);
					void doc.sharedFolder.backgroundSync.enqueueSync(
						doc,
						false,
						"download-empty",
					);
					doc.hsm?.send({ type: "DOWNLOAD_FAILED" });
					return undefined;
				}
				// The server pushes a document.updated event once a peer
				// uploads content, which re-enables downloads for the guid —
				// no timer-based retry needed.
				doc.sharedFolder.recordServerEmpty(doc.guid);
				this.log(
					"[transfer] Server contains uninitialized document. Waiting for peer to upload.",
				);
				doc.hsm?.send({ type: "DOWNLOAD_FAILED" });
				return undefined;
			}

			this.log("[transfer] applying content from server");
			Y.applyUpdate(doc.ydoc, updateBytes);
			doc.hsm?.setRemoteDoc(doc.ydoc);
			await this.maybeBootstrapMergeBase(context);
			doc.hsm?.send({ type: "DOWNLOAD_COMPLETE" });
			return updateBytes;
		} catch (e) {
			this.logError("[transfer] failed", e);
			doc.hsm?.send({ type: "DOWNLOAD_FAILED" });
			throw e;
		}
	}

	/**
	 * Establish the merge base from disk for a document that has none and is
	 * not active, waking it through the residency pool when it is cold.
	 */
	async maybeBootstrapMergeBase(context: SyncOperationContext): Promise<void> {
		const doc = this.doc;
		const hsm = doc.hsm;
		if (!hsm || hsm.state.lca || hsm.isActive()) return;

		// A first download has not written the file yet — the applied server
		// content materializes it through the WRITE_DISK effect. With no file
		// on disk there is no on-disk content to reconcile, so there is no
		// last-common-ancestor to recover from disk. Skip rather than read,
		// which would throw for the absent TFile and fail the download for a
		// doc that is simply arriving for the first time. The LCA is
		// established once the file lands, through the idle-merge path.
		if (!doc.tfile) {
			this.debug(
				`[bootstrapLCA] skipped for ${doc.path}: file not yet materialized`,
			);
			return;
		}

		let releaseLease: () => void = () => {};
		try {
			const mergeManager = doc.sharedFolder.mergeManager;
			if (mergeManager?.getHibernationState(doc.guid) === "hibernated") {
				const lease = mergeManager.wake(doc.guid, doc.ensureRemoteDoc(), {
					lease: true,
				});
				if (lease) {
					releaseLease = context.holdLease(lease);
				}
				await hsm.awaitPersistenceReady();
			}

			const diskState = await doc.readDiskContent();
			const repaired = await hsm.bootstrapLCAFromDisk(diskState);
			if (!repaired && hsm.getSyncStatus().status === "pending") {
				if (!hsm.hasPersistenceUserData()) {
					this.debug(
						`[bootstrapLCA] deferred for ${doc.path}: awaiting local CRDT enrollment`,
					);
					return;
				}
				this.debug(
					`[bootstrapLCA] skipped for ${doc.path}: local CRDT is not enrolled or remote state is not ready`,
				);
			}
		} catch (e) {
			this.warn(
				`[bootstrapLCA] failed for ${doc.path}: ${this.errorMessage(e)}`,
				e,
			);
			throw e;
		} finally {
			releaseLease();
		}
	}

	private errorMessage(error: unknown): string {
		return formatUserFacingError(error);
	}

	private logError(context: string, error: unknown): void {
		this.error(`${context}: ${this.errorMessage(error)}`, error);
	}
}
