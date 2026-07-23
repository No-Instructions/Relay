/**
 * Runtime invariant definitions for the folder membership engine, in the
 * family's declarative form. Two enforcement layers realize them:
 *
 * - emit-time invariants are enforced by the FolderHSM emit chokepoint,
 *   which THROWS on violation (capability grants, the blind-confidence
 *   gate, the read-only gate) — these can never be observed as state;
 * - state-shaped invariants are evaluated by FolderHSM.checkInvariants()
 *   on demand and by periodic checkers, reporting violations through the
 *   configured sink.
 *
 * This table is the single description of both layers; tests assert that
 * every id here is exercised by deliberately violating it.
 */

import type { FolderInvariantSeverity, FolderInvariantTrigger } from "./types";

export interface FolderInvariantDefinition {
	id: string;
	name: string;
	description: string;
	severity: FolderInvariantSeverity;
	trigger: FolderInvariantTrigger;
	/** Entry-state paths (exact or dot prefix) the check applies to; empty = all. */
	applicableStates: string[];
	/** Where the check runs. */
	enforcement: "emit-throw" | "check";
}

export const FOLDER_INVARIANTS: FolderInvariantDefinition[] = [
	{
		id: "effect-capability-granted",
		name: "Effects require granted capabilities",
		description:
			"Every emitted effect's required capability is granted by the current folder posture; refusal throws.",
		severity: "critical",
		trigger: "on-emit",
		applicableStates: [],
		enforcement: "emit-throw",
	},
	{
		id: "blind-never-dispatches",
		name: "Nothing destructive or publishing at blind confidence",
		description:
			"No TRASH_LOCAL, RENAME_LOCAL, or ENQUEUE_UPLOAD emits while the session tier is not confirmed.",
		severity: "critical",
		trigger: "on-emit",
		applicableStates: [],
		enforcement: "emit-throw",
	},
	{
		id: "readonly-never-writes",
		name: "No writes under read-only authorization",
		description:
			"No publishing or map-mutating effect emits under read-only authorization.",
		severity: "critical",
		trigger: "on-emit",
		applicableStates: [],
		enforcement: "emit-throw",
	},
	{
		id: "synced-agrees",
		name: "Synced rows agree with the committed map",
		description:
			"A synced row's identity is committed in the map at the row's path.",
		severity: "error",
		trigger: "on-state",
		applicableStates: ["synced"],
		enforcement: "check",
	},
	{
		id: "inflight-implies-ack",
		name: "In-flight rows carry acknowledged work",
		description:
			"An acknowledged work item (its identity) exists for every in-flight row.",
		severity: "warning",
		trigger: "periodic",
		applicableStates: ["upload.inFlight", "download.inFlight"],
		enforcement: "check",
	},
	{
		id: "parked-outside-index",
		name: "Parked rows have no committed entry",
		description: "No committed map entry exists at a parked row's path.",
		severity: "error",
		trigger: "on-state",
		applicableStates: ["parked"],
		enforcement: "check",
	},
	{
		id: "record-dies-with-row",
		name: "Records die with their rows",
		description:
			"No local record survives its row's retirement — a record never outlives the file it described.",
		severity: "error",
		trigger: "on-transition",
		applicableStates: [],
		enforcement: "check",
	},
	{
		id: "conflict-has-two-evidences",
		name: "Conflicts hold two positive evidences",
		description:
			"A conflicted row records positive evidence on both sides that genuinely disagrees.",
		severity: "warning",
		trigger: "on-state",
		applicableStates: ["conflicted"],
		enforcement: "check",
	},
	{
		id: "entry-event-refused",
		name: "Refusal writes nothing",
		description:
			"A refused event mutates no row and emits no effect; the refusal itself is reported.",
		severity: "warning",
		trigger: "on-refuse",
		applicableStates: [],
		enforcement: "check",
	},
];
