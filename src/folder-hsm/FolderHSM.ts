"use strict";

/**
 * The folder machine: boot posture and the permissions derived from it.
 *
 * One machine per SharedFolder, on the shared HSM runtime. It owns two
 * permissions:
 *
 * - `mayConnect` — the provider connection may open once the startup disk
 *   scan has finished, so server membership cannot race the scan's
 *   comparison against replayed state. (whenReady's brand-new-folder path
 *   bypasses the gate at the call site, as it always has.)
 * - `mayPublish` — with the sync-convergence latch enabled, locally minted
 *   identities may not publish until the provider's first completed sync.
 *
 * Waiters resolve on grant and at close; callers re-check `destroyed`
 * after resuming, exactly as they did against the latch promises this
 * machine replaces. Transition subscribers run synchronously inside the
 * event dispatch, before any waiter resumes.
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
	/** The sync-convergence latch: publication waits for the first
	 * completed provider sync. Read once at construction. */
	publicationLatch: boolean;
	onTransition?: (
		from: FolderStatePath,
		to: FolderStatePath,
		eventType: string,
	) => void;
}

export class FolderHSM implements MachineHost<FolderStatePath, FolderEvent> {
	private _statePath: FolderStatePath = "loading";
	private facts: FolderFacts = {
		replayComplete: false,
		diskScanned: false,
		providerSynced: false,
		closed: false,
	};
	private readonly publicationLatch: boolean;
	private readonly config: InterpreterConfig<
		FolderStatePath,
		FolderHSM,
		FolderEvent
	>;
	private waiters: { granted: () => boolean; resolve: () => void }[] = [];
	private subscribers = new Set<
		(state: FolderStatePath, previous: FolderStatePath) => void
	>();
	private invoke: ActiveInvoke | null = null;
	private currentEventType = "";

	constructor(private readonly options: FolderHSMOptions) {
		this.publicationLatch = options.publicationLatch;
		this.config = {
			guards: {
				shouldBeClosed: (host) => host.shouldBe("closed"),
				shouldBeLoading: (host) => host.shouldBe("loading"),
				shouldBeDiscovering: (host) => host.shouldBe("discovering"),
				shouldBeReconciling: (host) => host.shouldBe("reconciling"),
				shouldBeActive: (host) => host.shouldBe("active"),
			},
			actions: {
				recordReplayComplete: (host) => {
					host.facts.replayComplete = true;
				},
				recordDiskScanned: (host) => {
					host.facts.diskScanned = true;
				},
				recordProviderSynced: (host) => {
					host.facts.providerSynced = true;
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
			folderStateOf(this.facts, this.publicationLatch) === target &&
			this._statePath !== target
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

	get diskScanned(): boolean {
		return this.facts.diskScanned;
	}

	get providerSynced(): boolean {
		return this.facts.providerSynced;
	}

	get closed(): boolean {
		return this.facts.closed;
	}

	/** The provider connection may open: the startup disk scan finished. */
	get mayConnect(): boolean {
		return !this.facts.closed && this.facts.diskScanned;
	}

	/**
	 * Locally minted identities may publish. Derived from facts rather than
	 * from the state: with the latch disabled, publication is permitted even
	 * before the scan finishes, exactly as the latch it replaces behaved.
	 */
	get mayPublish(): boolean {
		return (
			!this.facts.closed &&
			(!this.publicationLatch || this.facts.providerSynced)
		);
	}

	/** Resolves when connecting is permitted, and at close. */
	whenMayConnect(): Promise<void> {
		return this.when(() => this.mayConnect);
	}

	/** Resolves when publication is permitted, and at close. */
	whenMayPublish(): Promise<void> {
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

	private when(granted: () => boolean): Promise<void> {
		if (this.facts.closed || granted()) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.waiters.push({ granted, resolve });
		});
	}

	private releaseWaiters(): void {
		if (this.waiters.length === 0) return;
		const remaining: typeof this.waiters = [];
		for (const waiter of this.waiters) {
			if (this.facts.closed || waiter.granted()) {
				waiter.resolve();
			} else {
				remaining.push(waiter);
			}
		}
		this.waiters = remaining;
	}
}
