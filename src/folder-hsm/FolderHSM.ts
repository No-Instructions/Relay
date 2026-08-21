"use strict";

/**
 * The folder machine: boot posture and the permissions derived from it.
 *
 * One machine per SharedFolder, on the shared HSM runtime. It owns three
 * permissions:
 *
 * - `mayConnect` — traffic may flow once the device has read its own state.
 *   Depends on `replayComplete` rather than on the state so a folder with
 *   no persisted membership can connect while still `loading`.
 * - `mayMint` — local discovery may mint identities once there is baseline
 *   evidence: the persisted membership if there is one, the server's first
 *   view if not.
 * - `mayPublish` — minted identities may publish once the initial
 *   reconcile can decide against the server's completed view.
 *
 * Waiters resolve `true` on grant and `false` at close; transition
 * subscribers run synchronously inside the event dispatch, before any
 * waiter resumes — work a transition must complete ahead of released
 * traffic (the initial reconcile's claim drops) belongs in a subscriber.
 */

import { processEvent } from "../hsm/interpreter";
import type {
	ActiveInvoke,
	InterpreterConfig,
	MachineHost,
} from "../hsm/types";
import { FOLDER_MACHINE, folderStateOf } from "./machine-definition";
import type { FolderEvent, FolderFacts, FolderStatePath } from "./types";

export interface FolderHSMOptions {
	/** An authoritative folder is its own membership authority and may have
	 * no provider to handshake with: the handshake requirement is vacuously
	 * satisfied. */
	authoritative?: boolean;
	onTransition?: (
		from: FolderStatePath,
		to: FolderStatePath,
		eventType: string,
	) => void;
}

export class FolderHSM implements MachineHost<FolderStatePath, FolderEvent> {
	private _statePath: FolderStatePath = "loading";
	private facts: FolderFacts;
	private readonly config: InterpreterConfig<
		FolderStatePath,
		FolderHSM,
		FolderEvent
	>;
	private waiters: {
		granted: () => boolean;
		resolve: (permitted: boolean) => void;
	}[] = [];
	private subscribers = new Set<
		(state: FolderStatePath, previous: FolderStatePath) => void
	>();
	private invoke: ActiveInvoke | null = null;
	private currentEventType = "";

	constructor(private readonly options: FolderHSMOptions = {}) {
		this.facts = {
			replayComplete: false,
			hasPersistedMembership: false,
			providerSynced: options.authoritative ?? false,
			diskScanned: false,
			initialReconcileComplete: false,
			closed: false,
		};
		this.config = {
			guards: {
				shouldBeClosed: (host) => host.shouldBe("closed"),
				shouldBeLoading: (host) => host.shouldBe("loading"),
				shouldBeDiscovering: (host) => host.shouldBe("discovering"),
				shouldBeReconciling: (host) => host.shouldBe("reconciling"),
				shouldBeActive: (host) => host.shouldBe("active"),
			},
			actions: {
				recordReplayComplete: (host, event) => {
					host.facts.replayComplete = true;
					if (
						event.type === "REPLAY_COMPLETE" &&
						event.hasPersistedMembership
					) {
						host.facts.hasPersistedMembership = true;
					}
				},
				recordDiskScanned: (host) => {
					host.facts.diskScanned = true;
				},
				recordProviderSynced: (host) => {
					host.facts.providerSynced = true;
				},
				recordInitialReconcileComplete: (host) => {
					host.facts.initialReconcileComplete = true;
				},
				recordClosed: (host) => {
					host.facts.closed = true;
				},
			},
			invokeSources: {},
		};
	}

	private shouldBe(target: FolderStatePath): boolean {
		return (
			folderStateOf(this.facts) === target && this._statePath !== target
		);
	}

	// =========================================================================
	// MachineHost surface
	// =========================================================================

	get statePath(): FolderStatePath {
		return this._statePath;
	}

	setStatePath(target: FolderStatePath): void {
		const from = this._statePath;
		this._statePath = target;
		if (from !== target) {
			this.options.onTransition?.(from, target, this.currentEventType);
			// Subscribers before waiters: transition work must complete before
			// any parked caller's continuation can be scheduled.
			for (const subscriber of [...this.subscribers]) {
				subscriber(target, from);
			}
		}
	}

	send(event: FolderEvent): void {
		if (this.facts.closed && event.type !== "CLOSE") {
			// Facts are monotone and closed is terminal; late events carry
			// nothing a waiter or subscriber could still act on.
			return;
		}
		this.currentEventType = event.type;
		processEvent(this, event, FOLDER_MACHINE, this.config);
		this.releaseWaiters();
	}

	getActiveInvoke(): ActiveInvoke | null {
		return this.invoke;
	}

	setActiveInvoke(invoke: ActiveInvoke | null): void {
		this.invoke = invoke;
	}

	// =========================================================================
	// Facts and permissions
	// =========================================================================

	get replayComplete(): boolean {
		return this.facts.replayComplete;
	}

	get providerSynced(): boolean {
		return this.facts.providerSynced;
	}

	get closed(): boolean {
		return this.facts.closed;
	}

	/** Traffic may flow: the device has read its own state. */
	get mayConnect(): boolean {
		return !this.facts.closed && this.facts.replayComplete;
	}

	/** Local discovery may mint identities. */
	get mayMint(): boolean {
		const state = this._statePath;
		return (
			state === "discovering" ||
			state === "reconciling" ||
			state === "active"
		);
	}

	/** Minted identities may publish. */
	get mayPublish(): boolean {
		const state = this._statePath;
		return state === "reconciling" || state === "active";
	}

	/**
	 * Still waiting for the server's first view to serve as the boot
	 * snapshot — the loading clause a folder with no persisted membership
	 * exits through.
	 */
	get needsServerSnapshot(): boolean {
		return (
			!this.facts.closed &&
			this.facts.replayComplete &&
			!this.facts.hasPersistedMembership &&
			!this.facts.providerSynced
		);
	}

	/** Resolves `true` when connecting is permitted, `false` at close. */
	whenMayConnect(): Promise<boolean> {
		return this.when(() => this.mayConnect);
	}

	/** Resolves `true` when minting is permitted, `false` at close. */
	whenMayMint(): Promise<boolean> {
		return this.when(() => this.mayMint);
	}

	/** Resolves `true` when publication is permitted, `false` at close. */
	whenMayPublish(): Promise<boolean> {
		return this.when(() => this.mayPublish);
	}

	/** Observe state transitions (synchronous, before waiters resume). */
	subscribe(
		callback: (state: FolderStatePath, previous: FolderStatePath) => void,
	): () => void {
		this.subscribers.add(callback);
		return () => {
			this.subscribers.delete(callback);
		};
	}

	close(): void {
		this.send({ type: "CLOSE" });
	}

	private when(granted: () => boolean): Promise<boolean> {
		if (this.facts.closed) return Promise.resolve(false);
		if (granted()) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			this.waiters.push({ granted, resolve });
		});
	}

	private releaseWaiters(): void {
		if (this.waiters.length === 0) return;
		const remaining: typeof this.waiters = [];
		for (const waiter of this.waiters) {
			if (this.facts.closed) {
				waiter.resolve(false);
			} else if (waiter.granted()) {
				waiter.resolve(true);
			} else {
				remaining.push(waiter);
			}
		}
		this.waiters = remaining;
	}
}
