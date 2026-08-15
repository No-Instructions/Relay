import type { RequestUrlResponse } from "obsidian";
import * as Y from "yjs";
import { S3RN, S3RemoteCanvas, S3RemoteDocument } from "../S3RN";
import { isDocument, type Document } from "../Document";
import { Canvas, isCanvas } from "../Canvas";
import type { CanvasData } from "../CanvasView";
import { areCanvasDataEqual } from "../CanvasData";
import { SyncFile } from "../SyncFile";
import type { SharedFolder } from "../SharedFolder";
import type { ClientToken } from "../client/types";
import type { TimeProvider } from "../TimeProvider";
import { HasLogging } from "../debug";
import { isEmptyDoc } from "../merge-hsm/snapshots";
import { errorFromUnknown, formatUserFacingError } from "../UserFacingError";
import { getRelayRequestHeaders, requestUrlWithMetrics } from "../customFetch";
import { RetryableProviderSyncError, isRetryableSyncError } from "./errors";
import { isDocumentConflicted } from "../merge-hsm/SyncPlanner";
import type { ProviderOperationToken } from "./DeadlineRegistry";
import type { SyncTarget } from "./types";

/**
 * What operations need from their host scheduler. Operations observe
 * cancellation at their stage boundaries, park warm-lease releases with the
 * deadline registry, and can hand a document back for an upload-direction
 * sync — they never touch queues, counters, or failure rows themselves.
 */
export interface OperationContext {
	timeProvider: TimeProvider;
	isSyncCancelled(doc: SyncTarget): boolean;
	/** Whether the target's fetch was cancelled (deletion, remap). */
	isFetchCancelled(doc: SyncTarget): boolean;
	registerLease(
		token: ProviderOperationToken,
		release: () => void,
	): () => void;
	enqueueSync(item: SyncTarget): void;
}

/**
 * The transfers the queues execute: provider sync sessions, upload
 * preparation, content downloads, attachment push and pull, and LCA
 * backfill. Retryability is signalled by throwing
 * RetryableProviderSyncError (or a retryable S3 error); classification,
 * backoff, and accounting belong to the queue and ledger.
 */
export class SyncOperations extends HasLogging {
	constructor(private ctx: OperationContext) {
		super();
	}

	private getAuthHeader(clientToken: ClientToken) {
		return {
			Authorization: `Bearer ${clientToken.token}`,
			...getRelayRequestHeaders(),
		};
	}

	private getBaseUrl(
		clientToken: ClientToken,
		entity: S3RemoteDocument | S3RemoteCanvas,
	): string {
		const urlObj = new URL(clientToken.url);
		urlObj.protocol = "https:";
		const parts = urlObj.pathname.split("/");
		parts.pop();
		parts.push(clientToken.docId);
		urlObj.pathname = parts.join("/");
		return clientToken.baseUrl?.replace(/\/$/, "") || urlObj.toString();
	}

	async downloadItem(item: Document | Canvas): Promise<RequestUrlResponse> {
		const getId = (entity: S3RemoteCanvas | S3RemoteDocument) => {
			if (entity instanceof S3RemoteCanvas) {
				return entity.canvasId;
			}
			return entity.documentId;
		};
		const entity = item.s3rn;
		this.log("[downloadItem]", item.path, `${S3RN.encode(entity)}`);

		if (
			!(entity instanceof S3RemoteDocument || entity instanceof S3RemoteCanvas)
		) {
			throw new Error(`Unable to decode S3RN: ${S3RN.encode(entity)}`);
		}

		const clientToken = await item.getProviderToken();
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrlWithMetrics({
			url: url,
			method: "GET",
			headers: headers,
			throw: false,
			relayNetworkDomain: "relay",
		});

		if (response.status === 200) {
			this.debug("[downloadItem]", getId(entity), response.status);
		} else {
			this.error(
				"[downloadItem]",
				getId(entity),
				url,
				response.status,
				response.text,
			);
			throw new Error(`Unable to download item: ${S3RN.encode(entity)}`);
		}
		return response;
	}

	/**
	 * Download raw CRDT bytes for a document by guid, without needing a
	 * Document instance. Used by the SharedFolder guid-remap path, where
	 * the server's content must be fetched *before* the old Document is
	 * destroyed — a failure here leaves old state intact and retriable.
	 *
	 * Does not participate in the download queue or in-progress tracking.
	 * It is a bare HTTP fetch.
	 *
	 * Returns undefined if the server has the guid registered but no
	 * peer has uploaded content yet (empty contents, empty users map).
	 */
	async downloadByGuid(
		sharedFolder: SharedFolder,
		guid: string,
		path: string,
		kind: "doc" | "canvas" = "doc",
	): Promise<Uint8Array | undefined> {
		const entity =
			kind === "canvas"
				? new S3RemoteCanvas(sharedFolder.relayId!, sharedFolder.guid, guid)
				: new S3RemoteDocument(
						sharedFolder.relayId!,
						sharedFolder.guid,
						guid,
					);
		this.log("[downloadByGuid]", path, S3RN.encode(entity));

		const clientToken = await sharedFolder.tokenStore.getToken(
			S3RN.encode(entity),
			path,
			() => {},
		);
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrlWithMetrics({
			url,
			method: "GET",
			headers,
			throw: false,
			relayNetworkDomain: "relay",
		});

		if (response.status !== 200) {
			this.error(
				"[downloadByGuid]",
				path,
				url,
				response.status,
				response.text,
			);
			throw new Error(
				`downloadByGuid: status ${response.status} for ${S3RN.encode(entity)}`,
			);
		}

		const updateBytes = new Uint8Array(response.arrayBuffer);

		// Peek at the update in a throwaway doc to detect empty-server.
		const tmpDoc = new Y.Doc();
		Y.applyUpdate(tmpDoc, updateBytes);
		if (isEmptyDoc(tmpDoc)) {
			this.log(
				"[downloadByGuid] server has guid registered but no content",
				path,
			);
			return undefined;
		}
		return updateBytes;
	}

	async syncDocumentWebsocket(
		doc: Document | Canvas,
		token: ProviderOperationToken,
	): Promise<boolean> {
		if (doc.destroyed) return false;
		this.log(
			`[syncDocWS] start: ${doc.path} guid=${doc.guid} intent=${doc.intent} connected=${doc.connected}`,
		);
		if (this.ctx.isSyncCancelled(doc)) return false;
		// if the local file is synced, then we do the two step process
		if (isCanvas(doc)) {
			// A cold canvas materializes on export; wait for the IDB replay
			// so the comparison runs against the real local state instead of
			// a freshly created empty localDoc.
			await doc.whenSynced();
			// Store the exported canvas data rather than a stringified version
			const currentCanvasData = doc.exportData();
			let canvasContentsMismatch = false;
			try {
				const currentFileContents = await doc.sharedFolder.read(doc);

				// Only proceed with update if file matches current ydoc state
				let contentsMatch = false;
				if (isCanvas(doc) && currentCanvasData) {
					// For canvas, use deep object comparison instead of string equality
					const currentFileJson = currentFileContents
						? JSON.parse(currentFileContents)
						: { nodes: [], edges: [] };
					contentsMatch = areCanvasDataEqual(
						currentCanvasData,
						currentFileJson,
					);
					if (
						!contentsMatch &&
						(await this.repairStaleCanvasText(doc, currentFileJson))
					) {
						contentsMatch = true;
					}
					if (!contentsMatch && currentFileContents) {
						canvasContentsMismatch = true;
					}
				}
			} catch (e) {
				// File does not exist
			}
			if (canvasContentsMismatch) {
				throw new Error(
					"Canvas file does not match local sync state. Open the canvas and resolve the local changes before syncing.",
				);
			}
		}
		// The session lifecycle — idle-integration acquisition, the sync
		// deadline, the became-active release guard — is the file's own
		// primitive; the operation contributes only the baseline bootstrap.
		const result = await doc.withEphemeralSession(
			{
				timeProvider: this.ctx.timeProvider,
				isCancelled: () => this.ctx.isSyncCancelled(doc),
			},
			async () => {
				if (isDocument(doc)) {
					await this.maybeBootstrapDocumentLCA(doc, token);
				}
				return true;
			},
		);
		return result !== false;
	}

	async getCanvas(canvas: Canvas): Promise<void> {
		if (canvas.sharedFolder.serverEmptyTerminal(canvas.guid)) {
			this.debug(
				`[getCanvas] skipped ${canvas.path}: server has no content for guid; awaiting server evidence`,
			);
			canvas.hsm.send({ type: "DOWNLOAD_FAILED" });
			return;
		}
		try {
			const response = await this.downloadItem(canvas);
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
					"[getCanvas] server has guid registered but no content",
					canvas.path,
				);
				canvas.hsm.send({ type: "DOWNLOAD_FAILED" });
				return;
			}

			// Cancelled mid-flight: do not apply; the machine hears a failed
			// download so its pending flag clears, matching the thrown path.
			if (this.ctx.isFetchCancelled(canvas)) {
				this.debug(`[getCanvas] cancelled mid-flight for ${canvas.path}`);
				canvas.hsm.send({ type: "DOWNLOAD_FAILED" });
				return;
			}
			this.log("[getCanvas] applying content from server");
			canvas.applyServerState(updateBytes);
		} catch (e) {
			this.logError("[getCanvas] failed", e);
			canvas.hsm.send({ type: "DOWNLOAD_FAILED" });
			throw e;
		}
	}

	async getDocument(
		doc: Document,
		token: ProviderOperationToken,
	): Promise<Uint8Array | undefined> {
		if (doc.sharedFolder.serverEmptyTerminal(doc.guid)) {
			this.debug(
				`[getDocument] skipped ${doc.path}: server has no content for guid; awaiting server evidence`,
			);
			return undefined;
		}
		try {
			const response = await this.downloadItem(doc);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			// Validate: reject uninitialized documents.
			const newDoc = new Y.Doc();
			Y.applyUpdate(newDoc, updateBytes);

			if (isEmptyDoc(newDoc)) {
				if (doc.text) {
					this.log(
						"[getDocument] server CRDT empty, local has content — uploading",
					);
					this.ctx.enqueueSync(doc);
					return undefined;
				}
				// The server pushes a document.updated event once a peer
				// uploads content, which re-enables downloads for the guid —
				// no timer-based retry needed.
				doc.sharedFolder.recordServerEmpty(doc.guid);
				this.log(
					"[getDocument] Server contains uninitialized document. Waiting for peer to upload.",
				);
				return undefined;
			}

			// A cancellation raised while the request was in flight makes the
			// downloaded bytes moot: applying them would land content on a
			// target a deletion or remap already invalidated.
			if (this.ctx.isFetchCancelled(doc)) {
				this.debug(`[getDocument] cancelled mid-flight for ${doc.path}`);
				return undefined;
			}
			this.log("[getDocument] applying content from server");
			doc.applyServerState(updateBytes);
			await this.maybeBootstrapDocumentLCA(doc, token);
			this.notifyDownloadedRemoteHead(doc);
			return updateBytes;
		} catch (e) {
			this.logError("[getDocument] failed", e);
			throw e;
		}
	}

	private notifyDownloadedRemoteHead(doc: Document): void {
		const hsm = doc.hsm;
		if (!hsm) return;

		hsm.send({ type: "PROVIDER_SYNCED" });
	}

	private async maybeBootstrapDocumentLCA(
		doc: Document,
		token: ProviderOperationToken,
	): Promise<void> {
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
					releaseLease = this.ctx.registerLease(token, lease);
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

	async syncFile(file: SyncFile): Promise<void> {
		await file.sync();
	}

	async getSyncFile(file: SyncFile): Promise<void> {
		await file.pull();
	}

	async syncDocument(
		doc: Document | Canvas,
		token: ProviderOperationToken,
	): Promise<void> {
		if (doc.destroyed) {
			return;
		}
		if (this.shouldSkipDocumentSync(doc)) {
			return;
		}
		try {
			if (isDocument(doc) || isCanvas(doc)) {
				const synced = await this.syncDocumentWebsocket(doc, token);
				if (!synced) {
					if (this.ctx.isSyncCancelled(doc)) return;
					throw new Error(`Unable to sync ${this.fileName(doc.path)}`);
				}
			}
		} catch (e) {
			if (!isRetryableSyncError(e)) {
				this.logError("[syncDocument] failed", e);
			}
			throw e;
		}
	}

	async syncDocumentUpload(
		doc: Document | Canvas,
		token: ProviderOperationToken,
	): Promise<void> {
		// The lease from upload preparation must survive the websocket sync
		// and the final content assert: hibernation mid-upload detaches the
		// remoteDoc, which surfaces as an empty remote after preparation.
		let releaseLease: () => void = () => {};
		try {
			if (isDocument(doc) && doc.hsm) {
				releaseLease = await this.prepareDocumentUpload(doc, token);
			}
			await this.syncDocument(doc, token);
			if (isDocument(doc) && doc.hsm) {
				this.assertUploadedDocumentHasRemoteContent(doc);
			}
		} finally {
			releaseLease();
		}
	}

	async syncDocumentLCABackfill(
		doc: Document,
		token: ProviderOperationToken,
	): Promise<void> {
		if (doc.destroyed || this.shouldSkipDocumentSync(doc)) {
			return;
		}

		const hsm = doc.hsm;
		if (!hsm || hsm.state.lca || hsm.isActive() || hsm.hasFork()) {
			return;
		}

		let updateBytes: Uint8Array | undefined;
		try {
			updateBytes = await this.downloadByGuid(
				doc.sharedFolder,
				doc.guid,
				doc.path,
			);
		} catch (error) {
			throw new RetryableProviderSyncError(
				`LCA backfill download failed for ${this.fileName(doc.path)}: ${this.errorMessage(error)}`,
				error,
			);
		}
		if (!updateBytes) {
			throw new RetryableProviderSyncError(
				`Remote document is empty while backfilling LCA: ${this.fileName(doc.path)}`,
			);
		}

		const validationDoc = new Y.Doc();
		try {
			Y.applyUpdate(validationDoc, updateBytes);
			if (isEmptyDoc(validationDoc)) {
				throw new RetryableProviderSyncError(
					`Remote document is empty while backfilling LCA: ${this.fileName(doc.path)}`,
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
				releaseLease = this.ctx.registerLease(token, lease);
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

	/**
	 * Wake the doc and encode its localDoc into the remoteDoc for upload.
	 * Returns the warm-lease release; the caller holds it until the upload
	 * resolves so hibernation cannot tear the doc down mid-pipeline.
	 */
	private async prepareDocumentUpload(
		doc: Document,
		token: ProviderOperationToken,
	): Promise<() => void> {
		const hsm = doc.hsm;
		if (!hsm) return () => {};
		if (hsm.hasFork()) {
			throw new Error(
				`Cannot upload ${this.fileName(doc.path)} while a fork exists`,
			);
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
					releaseLease = this.ctx.registerLease(token, lease);
				}
			}
		} else {
			hsm.setRemoteDoc(remoteDoc);
		}
		try {
			await hsm.awaitPersistenceReady();
			doc.pushLocalState();
			return releaseLease;
		} catch (e) {
			releaseLease();
			throw e;
		}
	}

	private assertUploadedDocumentHasRemoteContent(doc: Document): void {
		doc.assertRemoteHasContent();
	}

	private shouldSkipDocumentSync(item: SyncTarget): boolean {
		return isDocument(item) && isDocumentConflicted(item);
	}

	/**
	 * A canvas whose on-disk JSON diverged from its exported local state
	 * cannot sync safely. Returns the user-facing failure message, or null
	 * when the file matches (repairing stale text nodes when only the text
	 * representation lags the map data).
	 */
	async getCanvasLocalStateFailure(canvas: Canvas): Promise<string | null> {
		await canvas.whenSynced();
		let currentFileContents: string;
		try {
			currentFileContents = await canvas.sharedFolder.read(canvas);
		} catch (e) {
			return null;
		}
		if (!currentFileContents) return null;

		let currentFileJson: CanvasData;
		try {
			currentFileJson = JSON.parse(currentFileContents) as CanvasData;
		} catch (e) {
			return "Canvas file contains invalid JSON. Open the canvas and repair it before syncing.";
		}

		const currentCanvasData = canvas.exportData();
		if (areCanvasDataEqual(currentCanvasData, currentFileJson)) {
			return null;
		}
		if (await this.repairStaleCanvasText(canvas, currentFileJson)) {
			return null;
		}
		return "Canvas file does not match local sync state. Open the canvas and resolve the local changes before syncing.";
	}

	private async repairStaleCanvasText(
		canvas: Canvas,
		currentFileJson: CanvasData,
	): Promise<boolean> {
		const currentCanvasMapData = Canvas.exportCanvasMapData(canvas.localDoc);
		if (!areCanvasDataEqual(currentCanvasMapData, currentFileJson)) {
			return false;
		}

		await canvas.applyData(currentFileJson);
		return areCanvasDataEqual(canvas.exportData(), currentFileJson);
	}

	errorMessage(error: unknown): string {
		return formatUserFacingError(error);
	}

	errorFrom(error: unknown): Error {
		return errorFromUnknown(error);
	}

	private logError(context: string, error: unknown): void {
		this.error(`${context}: ${this.errorMessage(error)}`, error);
	}

	fileName(path: string): string {
		const normalized = path.replace(/\\/g, "/");
		const parts = normalized.split("/").filter(Boolean);
		return parts[parts.length - 1] || "file";
	}
}
