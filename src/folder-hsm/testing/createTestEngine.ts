/**
 * Test factory for the folder membership engine: an engine instance
 * bound to an in-memory substrate (map replica with tombstones, local
 * tree, record store, hold store), with effect capture, transition
 * capture, invariant-violation capture, and snapshot inspection.
 * Deterministic scheduling; no real timers or I/O.
 *
 * The substrate models what survives a restart: the committed map and
 * its tombstones, the local tree, the persisted records, and the
 * persisted upload holds. `restart()` builds a fresh engine over the
 * same substrate — the entry table itself is in-memory authority and is
 * deliberately lost.
 */

import { FolderHSM } from "../FolderHSM";
import type {
	FolderEffect,
	FolderEvent,
	FolderHSMConfig,
	FolderInvariantViolation,
	FolderStatePath,
	MapEntrySummary,
	MembershipEntry,
} from "../types";
import * as events from "./events";

export interface TestSubstrate {
	/** The committed membership map: path → identity. */
	index: Map<string, { guid: string; type?: string }>;
	/** Native tombstones: paths whose most recent map entry is a deletion. */
	tombstones: Set<string>;
	/** The local tree: what is actually on disk. */
	localTree: Set<string>;
	/** Persisted device-local records: path → identity + agreement flag. */
	records: Map<string, { guid: string; matchesDisk: boolean }>;
	/** Persisted upload holds: path → minted identity. */
	holds: Map<string, string>;
	/** The live replica's trust probe result. */
	pendingSyncState: boolean;
}

export interface Transition {
	from: FolderStatePath;
	to: FolderStatePath;
	eventType: string;
}

export interface TestEngineOptions {
	substrate?: Partial<TestSubstrate>;
	/** Automatically acknowledge dispatched work with WORK_STARTED. */
	autoAck?: boolean;
	/** Mint fresh identities for upload executions (host behavior). */
	mintOnUpload?: boolean;
}

export interface TestEngine {
	engine: FolderHSM;
	substrate: TestSubstrate;
	effects: FolderEffect[];
	transitions: Transition[];
	violations: FolderInvariantViolation[];
	/** Every event sent, in order — the recording for replay. */
	recorded: FolderEvent[];
	send(event: FolderEvent): void;
	/** PERSISTENCE_LOADED + confirmed PROVIDER_SYNCED. */
	hydrate(): void;
	/** PERSISTENCE_LOADED + blind PROVIDER_SYNCED (the persisted marker). */
	hydrateBlind(): void;
	/** Discover local files (adds to the tree and reports to the engine). */
	discover(...paths: string[]): void;
	/** Effects of one type. */
	effectsOf<T extends FolderEffect["type"]>(
		type: T,
	): Array<Extract<FolderEffect, { type: T }>>;
	entryFor(path: string): MembershipEntry | undefined;
	rowState(path: string): string | undefined;
	/** Substrate mutations that also deliver the matching delta. */
	remoteAdd(path: string, guid: string, type?: string): void;
	remoteRemove(path: string): void;
	remoteMove(guid: string, from: string, to: string): void;
	/** A fresh engine over the same substrate (the restart boundary). */
	restart(options?: Omit<TestEngineOptions, "substrate">): TestEngine;
}

function buildSubstrate(overrides: Partial<TestSubstrate>): TestSubstrate {
	return {
		index: overrides.index ?? new Map(),
		tombstones: overrides.tombstones ?? new Set(),
		localTree: overrides.localTree ?? new Set(),
		records: overrides.records ?? new Map(),
		holds: overrides.holds ?? new Map(),
		pendingSyncState: overrides.pendingSyncState ?? false,
	};
}

export function createTestEngine(
	options: TestEngineOptions = {},
): TestEngine {
	const substrate = buildSubstrate(options.substrate ?? {});
	return attachEngine(substrate, options);
}

function attachEngine(
	substrate: TestSubstrate,
	options: Omit<TestEngineOptions, "substrate">,
): TestEngine {
	const effects: FolderEffect[] = [];
	const transitions: Transition[] = [];
	const violations: FolderInvariantViolation[] = [];
	const recorded: FolderEvent[] = [];
	const autoAck = options.autoAck ?? false;
	const mintOnUpload = options.mintOnUpload ?? true;

	const pendingSends: FolderEvent[] = [];
	// Deterministic per-engine minting so recorded runs replay to
	// identical identities.
	let mintCounter = 0;
	let engine: FolderHSM;

	const config: FolderHSMConfig = {
		folderGuid: "test-folder",
		listMapEntries: (): MapEntrySummary[] =>
			Array.from(substrate.index.entries()).map(([path, entry]) => ({
				path,
				guid: entry.guid,
				type: entry.type,
			})),
		getMapEntry: (path: string) => {
			const entry = substrate.index.get(path);
			return entry
				? { path, guid: entry.guid, type: entry.type }
				: undefined;
		},
		pathTombstoned: (path: string) => substrate.tombstones.has(path),
		records: {
			getRecordGuid: (path: string) => substrate.records.get(path)?.guid,
			recordMatchesDisk: (path: string) =>
				substrate.records.get(path)?.matchesDisk ?? false,
			retireRecord: (path: string) => {
				substrate.records.delete(path);
			},
			moveRecord: (from: string, to: string) => {
				const record = substrate.records.get(from);
				if (!record) return;
				substrate.records.delete(from);
				substrate.records.set(to, record);
			},
		},
		holds: {
			getHold: (path: string) => substrate.holds.get(path),
			moveHold: (from: string, to: string) => {
				const guid = substrate.holds.get(from);
				if (guid === undefined) return;
				substrate.holds.delete(from);
				substrate.holds.set(to, guid);
			},
		},
		hasPendingSyncState: () => substrate.pendingSyncState,
		mergeableKind: (fileType?: string) => fileType === "markdown",
		onEffect: (effect) => {
			effects.push(effect);
			// The minimal host: executing an upload mints (or reuses) the
			// hold identity, exactly like the production enrollment path.
			if (effect.type === "ENQUEUE_UPLOAD" && mintOnUpload) {
				if (!substrate.holds.has(effect.path)) {
					substrate.holds.set(effect.path, `minted-${++mintCounter}`);
				}
				if (autoAck) {
					pendingSends.push(
						events.workStarted(
							"upload",
							effect.path,
							substrate.holds.get(effect.path)!,
						),
					);
				}
			}
			if (effect.type === "ENQUEUE_DOWNLOAD" && autoAck) {
				pendingSends.push(
					events.workStarted("download", effect.path, effect.guid),
				);
			}
			if (effect.type === "RETRACT_UPLOAD" && effect.releaseHold) {
				substrate.holds.delete(effect.path);
			}
		},
		onTransition: (from, to, eventType) =>
			transitions.push({ from, to, eventType }),
		onInvariantViolation: (violation) => violations.push(violation),
	};

	engine = new FolderHSM(config);

	const send = (event: FolderEvent): void => {
		recorded.push(event);
		engine.send(event);
		while (pendingSends.length > 0) {
			const queued = pendingSends.shift()!;
			recorded.push(queued);
			engine.send(queued);
		}
	};

	const discover = (...paths: string[]): void => {
		for (const path of paths) {
			substrate.localTree.add(path);
			send(events.fileDiscovered(path));
		}
	};

	const test: TestEngine = {
		engine,
		substrate,
		effects,
		transitions,
		violations,
		recorded,
		send,
		hydrate: () => {
			send(events.persistenceLoaded());
			send(events.providerSynced());
		},
		hydrateBlind: () => {
			send(events.persistenceLoaded());
			send(events.providerSynced("blind"));
		},
		discover,
		effectsOf: (type) =>
			effects.filter(
				(effect): effect is never => effect.type === type,
			) as never,
		entryFor: (path: string) =>
			engine.getSnapshot().entries.find((entry) => entry.path === path),
		rowState: (path: string) => engine.getRowState(path),
		remoteAdd: (path, guid, type) => {
			substrate.index.set(path, { guid, type });
			substrate.tombstones.delete(path);
			send(events.mapDelta({ adds: [{ path, guid, type }] }));
		},
		remoteRemove: (path) => {
			const existing = substrate.index.get(path);
			substrate.index.delete(path);
			substrate.tombstones.add(path);
			send(
				events.mapDelta({
					deletes: [
						{
							path,
							oldValue: existing
								? { id: existing.guid, type: existing.type }
								: undefined,
						},
					],
				}),
			);
		},
		remoteMove: (guid, from, to) => {
			const existing = substrate.index.get(from);
			substrate.index.delete(from);
			substrate.tombstones.add(from);
			substrate.index.set(to, { guid, type: existing?.type });
			substrate.tombstones.delete(to);
			send(events.mapDelta({ moves: [{ guid, from, to }] }));
		},
		restart: (restartOptions = {}) =>
			attachEngine(substrate, { ...options, ...restartOptions }),
	};
	return test;
}
