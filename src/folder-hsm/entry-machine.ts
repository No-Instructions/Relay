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
 * - destruction requires positive identity association over a
 *   provider-synced picture — absence never deletes, and content is
 *   never consulted: identity decides, so the outcome cannot depend on
 *   event ordering;
 * - a path carrying a persisted upload hold is never trashed and its
 *   minted identity is never silently discarded: the hold marks content
 *   the server does not have;
 * - publication requires live user intent or a classification verdict
 *   over a provider-synced picture, and dispatch additionally requires
 *   write authorization;
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
				// A committed identity standing at a path that also carries
				// this device's own unpublished mint. Taking the committed
				// identity here is not bookkeeping: the mint is discarded
				// and the path rebinds onto a history this device has never
				// seen. So the rung carries the same evidence bar and the
				// same effect as the live supersession route
				// (upload.held/MAP_ADDED) — retract the superseded mint
				// naming the committed identity as the rebind target, then
				// adopt. A completed provider sync is a bar on the map, not
				// a promise that the rebind can run; the host keeps the
				// mint, its document and its durable hold until the rebind
				// has actually completed, so a rebind that cannot run yet
				// costs nothing and is retried from the same evidence.
				{
					target: "synced",
					guard: "committedIdentitySupersedesHold",
					actions: [
						"retractSupersededMintAndRebind",
						"adoptCommittedIdentity",
					],
				},
				// Adoption of the committed identity is row bookkeeping: a
				// synced row always carries the identity the map holds.
				// Only when no unpublished mint competes with it — with one
				// competing, either the rung above takes the path (and
				// rebinds it) or the hold rung below keeps it on its mint,
				// so the row never adopts an identity the path's own
				// lookups do not resolve to.
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
				// Every rung below decides a classification verdict over the
				// map — condemnation, rename-to-follow, refusal, bootstrap
				// publication. None is decidable before a live exchange has
				// synced the picture: the row waits here, in the explicit
				// waiting state, and the first synced pass decides it once.
				// (Adoption, hold resumption, and live user intent above are
				// not verdicts over the map and do not wait.)
				{ target: "unclassified", guard: "verdictAwaitsProviderSync" },
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
				// A directory in a subtree the group deleted, still holding
				// children: each child's own row decides its fate, and the
				// directory waits — publication work for a doomed directory
				// and a parked verdict are both wrong. When the last
				// child's trash completes, the emptied-parent review
				// re-runs this ladder and the rung above removes the
				// directory.
				{
					target: "unclassified",
					guard: "tombstonedDirectoryAwaitingChildren",
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
			// A removal reaching a row still undecided: condemn on identity
			// over a synced picture; absorb otherwise — never trash on this
			// event. Pre-sync, a guid-less row adopts the identity the
			// removal names: the map is the durable record of the removal,
			// and the identity on the row is what lets the first synced
			// classification pass re-derive it from that map.
			MAP_REMOVED: [
				{
					target: "trashing",
					guard: "identityMatches",
					actions: ["emitTrashLocal"],
					requires: ["canTrash"],
				},
				{ target: "unclassified", actions: ["adoptRemovalIdentity"] },
			],
			FILE_CREATED: {
				target: "unclassified",
				actions: ["upgradeOriginInteractive", "scheduleClassify"],
			},
			FILE_DELETED: [
				// The row's identity already left the committed map at this
				// path: the local delete is agreement with a removal (or
				// move) the group already committed — nothing remains to
				// replicate.
				{ target: "retired", guard: "identityLeftPath" },
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
				// Before a completed live exchange the removal cannot act —
				// destruction never runs from an unsynced picture — and
				// nothing needs recording: the row holds its place, the map
				// is the durable record, and the first synced classification
				// pass re-derives the removal from it (an identity
				// re-committed in the meantime simply no longer reads as
				// removed).
				{ target: "synced", guard: "removalAwaitsProviderSync" },
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
				// The rename-away form of a pre-sync removal: the local file
				// must follow its identity, but the local rename is
				// destructive at the source and waits for a completed
				// exchange. The row holds its place; the first synced pass
				// re-derives the destination from the map of that moment
				// and completes it as a rename.
				{ target: "synced", guard: "moveAwayAwaitsProviderSync" },
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
			FILE_DELETED: [
				// The row's identity no longer stands committed at this path
				// (the group already removed or moved it): the local delete
				// is agreement, not new intent — nothing remains to
				// replicate, and a minted delete here would target an entry
				// that no longer exists (or a different document's).
				{ target: "retired", guard: "identityLeftPath" },
				{
					target: "delete.pending",
					actions: ["recordObservedIdentity", "emitIndexDelete"],
					requires: ["canMutateMap"],
				},
			],
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
		// Dispatch is gated: ENQUEUE_UPLOAD emits only after a completed
		// provider sync and under write authorization; otherwise the
		// intent queues silently and dispatch fires on the sync or
		// authorization edge.
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
				// The map commits a different identity at this path than the
				// row's unpublished mint: the same supersession contract as
				// the live MAP_ADDED route below, reached when the committed
				// entry was already in the picture the pass reads (a hold
				// adopted before the session's first completed exchange, or
				// an entry that landed while the row queued).
				{
					target: "synced",
					guard: "committedIdentitySupersedesHold",
					actions: [
						"retractSupersededMintAndRebind",
						"adoptCommittedIdentity",
					],
				},
				// An emptied directory at a deleted path: directories hold
				// no content to protect, so the queued work is cancelled
				// and the directory is removed like any other stale
				// materialization. Reached when the deletion emptied the
				// directory after this row minted (the emptied-parent
				// review re-runs classification here).
				{
					target: "trashing",
					guard: "tombstonedEmptyDirectory",
					actions: ["emitCancelUploadWork", "emitTrashLocal"],
					requires: ["canTrash"],
				},
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
