/**
 * The entry machine — the per-file membership transition table.
 *
 * A second declarative constant in the family's state-node grammar
 * (dotted paths, guard-ordered candidates, named guards/actions), with
 * two deliberate restrictions: no `invoke` and no `always` — entry
 * transitions are synchronous, executed as row ticks from inside the
 * folder machine's actions, on its single event queue.
 *
 * Every node declares an `otherwise` policy so no (state x event) cell
 * can be silently consumed: an unconsidered event is exactly where files
 * get lost. The exhaustive test walk fails on any cell covered by
 * neither a handler nor a policy.
 *
 * Candidates that emit effects declare the folder-posture capabilities
 * those effects require (`requires`); the emit chokepoint checks the
 * cross-product and refuses on violation.
 *
 * Evidence rules the guards encode (see FolderHSM for the bindings):
 * - destruction requires positive identity association at confirmed
 *   confidence — absence never deletes, and content is never consulted:
 *   identity decides, so the outcome cannot depend on event ordering;
 * - a path carrying a persisted upload hold is never trashed and its
 *   minted identity is never silently discarded: the hold marks content
 *   the server does not have;
 * - publication requires live user intent or a confirmed-confidence
 *   verdict, and dispatch additionally requires write authorization;
 * - acknowledged work is adopted, never re-emitted; unacknowledged
 *   intent re-emits at-least-once.
 */

import type { EntryMachineDefinition, EntryRefusal } from "./types";

const REFUSE: EntryRefusal = { refuse: true };

export const ENTRY_MACHINE: EntryMachineDefinition = {
	unclassified: {
		otherwise: "absorb",
		on: {
			// The evidence ladder: first passing guard wins.
			CLASSIFY: [
				// Adoption of the committed identity is row bookkeeping: a
				// synced row always carries the identity the map holds.
				{
					target: "synced",
					guard: "indexEntryAtPathWithLocalFile",
					actions: ["adoptCommittedIdentity"],
				},
				{
					target: "upload.held",
					guard: "holdAdoptable",
					actions: ["adoptHold"],
				},
				{
					target: "upload.held",
					guard: "originInteractive",
					actions: ["mintHold"],
				},
				{
					target: "renaming",
					guard: "recordAliveElsewhere",
					actions: ["emitRenameLocal"],
					requires: ["canRenameLocal"],
				},
				{
					target: "trashing",
					guard: "staleCopyCondemned",
					actions: ["emitTrashLocal"],
					requires: ["canTrash"],
				},
				{
					target: "trashing",
					guard: "tombstonedEmptyDirectory",
					actions: ["emitTrashLocal"],
					requires: ["canTrash"],
				},
				{
					target: "parked",
					guard: "tombstoned",
					actions: ["recordReason", "emitPark"],
					requires: ["canPark"],
				},
				{
					target: "upload.held",
					guard: "isLocalFile",
					actions: ["mintHold"],
				},
				{
					target: "delete.pending",
					guard: "recordedDeleteIntent",
					actions: ["emitIndexDelete"],
					requires: ["canMutateMap"],
				},
				{
					target: "download.pending",
					actions: ["emitEnqueueDownload"],
					requires: ["canDownload"],
				},
			],
			FILE_CREATED: {
				target: "unclassified",
				actions: ["upgradeOriginInteractive", "scheduleClassify"],
			},
			FILE_DELETED: [
				{
					target: "delete.pending",
					guard: "indexEntryKnown",
					actions: ["emitIndexDelete"],
					requires: ["canMutateMap"],
				},
				{ target: "retired", actions: ["recordDeleteIntent"] },
			],
		},
	},

	synced: {
		// MAP_UPDATED / FILE_DISCOVERED / FILE_MODIFIED absorb (content
		// convergence is out of scope; content evidence is marked stale on
		// FILE_MODIFIED). Completions and acks with no outstanding work
		// refuse explicitly below.
		otherwise: "absorb",
		on: {
			MAP_REMOVED: [
				// Removal prevails into recoverable trash: identity decides,
				// content never does. A locally edited copy trashes the same
				// as an untouched one — the trash keeps the bytes recoverable.
				{
					target: "trashing",
					guard: "identityMatches",
					actions: ["emitTrashLocal"],
					requires: ["canTrash"],
				},
				// Identity mismatch: the removed entry was a different
				// document — never trash on this event; reclassify against
				// present truth.
				{ target: "unclassified", actions: ["scheduleClassify"] },
			],
			MAP_MOVED: [
				{
					target: "renaming",
					guard: "sourceFilePresent",
					actions: ["emitRenameLocal"],
					requires: ["canRenameLocal"],
				},
				{
					target: "synced",
					guard: "destinationPresent",
					actions: ["rekeyRow"],
				},
				{
					target: "download.pending",
					actions: ["rekeyRow", "emitEnqueueDownload"],
					requires: ["canDownload"],
				},
			],
			FILE_DELETED: {
				target: "delete.pending",
				actions: ["recordObservedIdentity", "emitIndexDelete"],
				requires: ["canMutateMap"],
			},
			// Carries the observed identity outbound.
			FILE_RENAMED_AWAY: {
				target: "synced",
				actions: ["rekeyRow", "emitIndexSet"],
				requires: ["canMutateMap"],
			},
			WORK_STARTED: REFUSE,
			UPLOAD_COMPLETE: REFUSE,
			DOWNLOAD_COMPLETE: REFUSE,
		},
	},

	"upload.held": {
		// Dispatch is gated: ENQUEUE_UPLOAD emits only under confirmed
		// tier and write authorization; otherwise the intent queues
		// silently and dispatch fires on the tier/authorization edge.
		entry: ["dispatchUploadIfPermitted"],
		otherwise: "absorb",
		on: {
			// The acknowledgment carries the accepted work item's identity;
			// the row adopts it (bookkeeping for the in-flight contract).
			WORK_STARTED: {
				target: "upload.inFlight",
				actions: ["adoptAcknowledgedIdentity"],
			},
			UPLOAD_COMPLETE: {
				target: "synced",
				actions: ["recordContentEvidence"],
			},
			// Retried on the next occasion.
			UPLOAD_FAILED: { target: "upload.held" },
			CLASSIFY: [
				// A re-run saw the deletion the minting pass could not: the
				// queued work is cancelled, but the hold's minted identity is
				// PRESERVED with the parked file — held-but-unpublished
				// content is never condemned.
				{
					target: "parked",
					guard: "tombstonedBootstrapHold",
					actions: [
						"emitCancelUploadWork",
						"recordReason",
						"emitPark",
					],
					requires: ["canPark"],
				},
				// At-least-once until acknowledged.
				{
					target: "upload.held",
					actions: ["redispatchIfUnacknowledged"],
				},
			],
			MAP_ADDED: [
				// A peer published this path first: the unpublished mint is
				// superseded. The retraction names the committed identity so
				// the host rebinds the path's document to the committed
				// history (the row lands in `synced` with no download
				// queued); then the row adopts the committed identity. When
				// the committed identity is our own mint replicated back,
				// nothing retracts.
				{
					target: "synced",
					guard: "committedIdentityAtPath",
					actions: [
						"retractSupersededMintAndRebind",
						"adoptCommittedIdentity",
					],
				},
				{ target: "upload.held" },
			],
			// The user deleted the local file: explicit action releases the
			// hold with the row.
			FILE_DELETED: { target: "retired", actions: ["emitRetractUpload"] },
			FILE_RENAMED_AWAY: {
				target: "upload.held",
				actions: ["rekeyRowAndHold"],
			},
			// Content is read at execution time.
			FILE_MODIFIED: { target: "upload.held" },
		},
	},

	"upload.inFlight": {
		otherwise: "absorb",
		on: {
			UPLOAD_COMPLETE: {
				target: "synced",
				actions: ["recordContentEvidence"],
			},
			UPLOAD_FAILED: "upload.held",
			CLASSIFY: [
				{
					target: "parked",
					guard: "tombstonedBootstrapHold",
					actions: [
						"emitCancelUploadWork",
						"recordReason",
						"emitPark",
					],
					requires: ["canPark"],
				},
				// Adopt: acknowledged work is never re-emitted.
				{ target: "upload.inFlight" },
			],
			MAP_ADDED: [
				// Same supersession contract as upload.held: retract naming
				// the committed identity as the rebind target, then adopt.
				{
					target: "synced",
					guard: "committedIdentityAtPath",
					actions: [
						"retractSupersededMintAndRebind",
						"adoptCommittedIdentity",
					],
				},
				{ target: "upload.inFlight" },
			],
			// A late completion afterwards hits refuse and writes no
			// membership.
			FILE_DELETED: { target: "retired", actions: ["emitRetractUpload"] },
		},
	},

	"download.pending": {
		otherwise: "absorb",
		on: {
			WORK_STARTED: {
				target: "download.inFlight",
				actions: ["adoptAcknowledgedIdentity"],
			},
			DOWNLOAD_COMPLETE: {
				target: "synced",
				actions: ["recordContentEvidence"],
			},
			// Delta- and classification-driven retries.
			DOWNLOAD_FAILED: { target: "download.pending" },
			CLASSIFY: {
				target: "download.pending",
				actions: ["redispatchIfUnacknowledged"],
			},
			MAP_ADDED: {
				target: "download.pending",
				actions: ["redispatchIfUnacknowledged"],
			},
			MAP_REMOVED: [
				{ target: "retired", guard: "identityMatches" },
				{ target: "unclassified", actions: ["scheduleClassify"] },
			],
			MAP_MOVED: { target: "download.pending", actions: ["rekeyRow"] },
			// Materialized; content convergence is out of scope.
			FILE_CREATED: { target: "synced" },
			FILE_DISCOVERED: { target: "synced" },
		},
	},

	"download.inFlight": {
		otherwise: "absorb",
		on: {
			DOWNLOAD_COMPLETE: {
				target: "synced",
				actions: ["recordContentEvidence"],
			},
			DOWNLOAD_FAILED: "download.pending",
			// Adopt; never re-emit.
			CLASSIFY: { target: "download.inFlight" },
			MAP_REMOVED: [
				{
					target: "retired",
					guard: "identityMatches",
					actions: ["cancelWork"],
				},
				{ target: "unclassified", actions: ["scheduleClassify"] },
			],
			// Work follows identity.
			MAP_MOVED: { target: "download.inFlight", actions: ["rekeyRow"] },
			FILE_CREATED: { target: "synced" },
		},
	},

	trashing: {
		// Including MAP_ADDED: after TRASH_COMPLETE the re-added entry
		// classifies to download.pending; the trash is recoverable and the
		// window is declared. No completion with the file still present
		// leaves the row trashing, retried by the next matching delta or
		// classification pass.
		otherwise: "absorb",
		on: {
			// Retirement retires the local record with the row.
			TRASH_COMPLETE: { target: "retired" },
			// The platform echo; completion arrives as TRASH_COMPLETE.
			FILE_DELETED: { target: "trashing" },
		},
	},

	renaming: {
		otherwise: "absorb",
		on: {
			// The echo cell.
			FILE_RENAMED_IN: { target: "synced" },
			// A colliding user rename.
			FILE_RENAMED_AWAY: {
				target: "unclassified",
				actions: ["scheduleClassify"],
			},
			MAP_MOVED: { target: "renaming", actions: ["rekeyRow"] },
		},
	},

	"delete.pending": {
		otherwise: "absorb",
		on: {
			DELETE_REPLICATED: [
				{ target: "retired", guard: "observedIdentityStillCommitted" },
				{
					target: "unclassified",
					actions: ["dropIntent", "surfaceDrop", "scheduleClassify"],
				},
			],
			DELETE_HELD: "delete.held",
			DELETE_RESTORED: {
				target: "download.pending",
				actions: ["emitEnqueueDownload"],
				requires: ["canDownload"],
			},
			// Re-creation leaves the burst.
			FILE_CREATED: {
				target: "unclassified",
				actions: ["scheduleClassify"],
			},
			// A peer changed what this device decided to delete: the
			// evidence no longer matches.
			MAP_UPDATED: {
				target: "unclassified",
				actions: ["dropIntent", "surfaceDrop", "scheduleClassify"],
			},
			MAP_MOVED: {
				target: "unclassified",
				actions: ["dropIntent", "surfaceDrop", "scheduleClassify"],
			},
		},
	},

	"delete.held": {
		// The burst resolves as a unit; only explicit resolution or
		// re-creation moves a held row.
		otherwise: "absorb",
		on: {
			DELETE_REPLICATED: [
				{ target: "retired", guard: "observedIdentityStillCommitted" },
				{
					target: "unclassified",
					actions: ["dropIntent", "surfaceDrop", "scheduleClassify"],
				},
			],
			DELETE_RESTORED: {
				target: "download.pending",
				actions: ["emitEnqueueDownload"],
				requires: ["canDownload"],
			},
			FILE_CREATED: {
				target: "unclassified",
				actions: ["scheduleClassify"],
			},
		},
	},

	parked: {
		otherwise: "absorb",
		on: {
			UNPARK_REQUESTED: {
				target: "upload.held",
				actions: ["setOriginInteractive", "mintHold"],
			},
			FILE_CREATED: {
				target: "upload.held",
				actions: ["setOriginInteractive", "mintHold"],
			},
			// NEVER publishes: editing a refused file only re-surfaces it.
			FILE_MODIFIED: { target: "parked", actions: ["emitSurfaceStatus"] },
			// Explicit local deletion is one of parked's declared exits, and
			// it releases a preserved hold with the row: a durable identity
			// never outlives the file it was minted for.
			FILE_DELETED: { target: "retired", actions: ["emitRetractUpload"] },
			MAP_ADDED: [
				// The group asserted mergeable content at the refused path:
				// converge to the committed identity. A preserved mint the
				// row adopted is superseded and retracts with its hold.
				{
					target: "download.pending",
					guard: "mergeableKind",
					actions: ["retractSupersededMint", "emitEnqueueDownload"],
					requires: ["canDownload"],
				},
				// Unmergeable content on both sides.
				{
					target: "conflicted",
					actions: ["recordEvidencePair", "emitSurfaceStatus"],
				},
			],
		},
	},

	conflicted: {
		otherwise: "absorb",
		on: {
			RESOLVE_CONFLICT: [
				{
					target: "upload.held",
					guard: "verdictKeepLocal",
					actions: ["setOriginInteractive", "mintHold"],
				},
				// Keep-remote is the explicit user action that sanctions
				// discarding an unpublished mint the row carries.
				{
					target: "download.pending",
					guard: "verdictKeepRemote",
					actions: ["retractSupersededMint", "emitEnqueueDownload"],
					requires: ["canDownload"],
				},
				{
					target: "trashing",
					guard: "verdictKeepRemoteWithLocalFile",
					actions: ["emitTrashLocal"],
					requires: ["canTrash"],
				},
			],
			FILE_DELETED: [
				{
					target: "delete.pending",
					guard: "indexEntryKnown",
					actions: ["recordObservedIdentity", "emitIndexDelete"],
					requires: ["canMutateMap"],
				},
				{ target: "retired" },
			],
			// New evidence may dissolve the disagreement; auto-resolution
			// only ever lands in non-destructive verdicts via CLASSIFY.
			MAP_REMOVED: {
				target: "unclassified",
				actions: ["scheduleClassify"],
			},
			MAP_UPDATED: {
				target: "unclassified",
				actions: ["scheduleClassify"],
			},
		},
	},
};

/** All entry state paths, for structural walks. */
export const ENTRY_STATE_PATHS = Object.keys(
	ENTRY_MACHINE,
) as Array<keyof typeof ENTRY_MACHINE>;

/** Every event type the entry machine can be addressed with. */
export const ENTRY_EVENT_TYPES = [
	"CLASSIFY",
	"MAP_ADDED",
	"MAP_UPDATED",
	"MAP_REMOVED",
	"MAP_MOVED",
	"FILE_DISCOVERED",
	"FILE_CREATED",
	"FILE_MODIFIED",
	"FILE_DELETED",
	"FILE_RENAMED_AWAY",
	"FILE_RENAMED_IN",
	"WORK_STARTED",
	"UPLOAD_COMPLETE",
	"UPLOAD_FAILED",
	"DOWNLOAD_COMPLETE",
	"DOWNLOAD_FAILED",
	"TRASH_COMPLETE",
	"DELETE_HELD",
	"DELETE_REPLICATED",
	"DELETE_RESTORED",
	"UNPARK_REQUESTED",
	"RESOLVE_CONFLICT",
] as const;
