"use strict";

/**
 * The folder's bootstrap gates, as states derived from monotone facts.
 *
 * The machine owns three permissions: *may mint identity*, *may publish*,
 * and *may open the bridge*. Holding folder traffic until the device has
 * read its own state gives the engine a stable window in which to
 * materialize its models and take the boot baseline before anything can
 * move it; once the directions are decided, traffic flows.
 *
 * Every fact is monotone — false to true, once — so the state is monotone
 * too: it cannot go backwards. The state is a pure total function of the
 * facts (`bootstrapStateOf`), exported so that property is asserted by an
 * exhaustive test over all fact combinations rather than by review.
 *
 * A folder with no local database has no baseline to read, so it must get
 * one from the server before it may mint: `loading` exits on *baseline
 * evidence* — the persisted realm if there is one, the server's first view
 * if not. That such a folder must connect while still loading is expressed
 * by `mayOpenBridge` depending on `localStateRead` rather than on the
 * state.
 *
 * No Obsidian or logging dependencies; the module tests as a value.
 */

export interface FolderBootstrapFacts {
	/** The persistence replay finished. */
	localStateRead: boolean;
	/** This device has a folder DB to read (or a persisted server-sync marker). */
	hasPersistedRemoteRealm: boolean;
	/** The provider completed a handshake (vacuous when authoritative). */
	serverViewArrived: boolean;
	/** The startup scan finished. */
	diskReconciled: boolean;
	/** Realm reconciliation finished. */
	crossingDrained: boolean;
	/** Destroyed. */
	closed: boolean;
}

export type FolderBootstrapState =
	| "loading"
	| "baselined"
	| "crossing"
	| "active"
	| "closed";

/** The state, as a pure total function of the facts: a descending cascade. */
export function bootstrapStateOf(
	facts: FolderBootstrapFacts,
): FolderBootstrapState {
	if (facts.closed) return "closed";
	if (!facts.localStateRead) return "loading";
	if (!facts.hasPersistedRemoteRealm && !facts.serverViewArrived) {
		return "loading";
	}
	if (!(facts.diskReconciled && facts.serverViewArrived)) return "baselined";
	if (!facts.crossingDrained) return "crossing";
	return "active";
}

type Waiter = {
	granted: () => boolean;
	resolve: (permitted: boolean) => void;
};

export class FolderBootstrap {
	private facts: FolderBootstrapFacts;
	private waiters: Waiter[] = [];
	private subscribers = new Set<
		(state: FolderBootstrapState, previous: FolderBootstrapState) => void
	>();

	constructor(options: { authoritative?: boolean } = {}) {
		this.facts = {
			localStateRead: false,
			hasPersistedRemoteRealm: false,
			// An authoritative folder is its own membership authority and may
			// have no provider to handshake with: the handshake requirement is
			// vacuously satisfied.
			serverViewArrived: options.authoritative ?? false,
			diskReconciled: false,
			crossingDrained: false,
			closed: false,
		};
	}

	get state(): FolderBootstrapState {
		return bootstrapStateOf(this.facts);
	}

	/**
	 * Traffic may flow once the device has read its own state. This depends
	 * on `localStateRead` rather than on the state so a folder with no local
	 * database can connect while still loading.
	 */
	get mayOpenBridge(): boolean {
		return !this.facts.closed && this.facts.localStateRead;
	}

	get mayMint(): boolean {
		const state = this.state;
		return state === "baselined" || state === "crossing" || state === "active";
	}

	get mayPublish(): boolean {
		const state = this.state;
		return state === "crossing" || state === "active";
	}

	/**
	 * Still waiting for the server's first view to serve as the boot
	 * baseline — the loading clause a folder with no local database exits
	 * through.
	 */
	get awaitingServerBaseline(): boolean {
		return (
			!this.facts.closed &&
			this.facts.localStateRead &&
			!this.facts.hasPersistedRemoteRealm &&
			!this.facts.serverViewArrived
		);
	}

	/** The persistence replay finished; the boot baseline is fixed. */
	reportLocalStateRead(hasPersistedRemoteRealm: boolean): void {
		this.report((facts) => {
			facts.localStateRead = true;
			if (hasPersistedRemoteRealm) facts.hasPersistedRemoteRealm = true;
		});
	}

	/** The provider completed a handshake. */
	reportServerViewArrived(): void {
		this.report((facts) => {
			facts.serverViewArrived = true;
		});
	}

	/** The startup scan finished. */
	reportDiskReconciled(): void {
		this.report((facts) => {
			facts.diskReconciled = true;
		});
	}

	/** Realm reconciliation finished. */
	reportCrossingDrained(): void {
		this.report((facts) => {
			facts.crossingDrained = true;
		});
	}

	/** Teardown. Every parked waiter resolves `false` instead of stranding. */
	close(): void {
		this.report((facts) => {
			facts.closed = true;
		});
	}

	/**
	 * Observe state transitions. Callbacks run synchronously inside the fact
	 * report that caused the transition, before any parked waiter resumes —
	 * work a transition must complete ahead of released traffic (the
	 * crossing's claim drops) belongs here.
	 */
	subscribe(
		callback: (
			state: FolderBootstrapState,
			previous: FolderBootstrapState,
		) => void,
	): () => void {
		this.subscribers.add(callback);
		return () => {
			this.subscribers.delete(callback);
		};
	}

	/** Resolves `true` when the bridge may open, `false` at teardown. */
	whenMayOpenBridge(): Promise<boolean> {
		return this.when(() => this.mayOpenBridge);
	}

	/** Resolves `true` when minting is permitted, `false` at teardown. */
	whenMayMint(): Promise<boolean> {
		return this.when(() => this.mayMint);
	}

	/** Resolves `true` when publication is permitted, `false` at teardown. */
	whenMayPublish(): Promise<boolean> {
		return this.when(() => this.mayPublish);
	}

	private when(granted: () => boolean): Promise<boolean> {
		if (this.facts.closed) return Promise.resolve(false);
		if (granted()) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			this.waiters.push({ granted, resolve });
		});
	}

	private report(mutate: (facts: FolderBootstrapFacts) => void): void {
		const previous = this.state;
		mutate(this.facts);
		const state = this.state;
		if (state !== previous) {
			// Subscribers first: transition work (the crossing's claim drops)
			// runs synchronously before any parked waiter's continuation can
			// be scheduled.
			for (const subscriber of [...this.subscribers]) {
				subscriber(state, previous);
			}
		}
		if (this.waiters.length === 0) return;
		const remaining: Waiter[] = [];
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
