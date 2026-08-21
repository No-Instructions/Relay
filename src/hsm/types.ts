"use strict";

/**
 * Generic types for the declarative HSM runtime. Consumers bind their own
 * state-path and event unions (merge-hsm, canvas-hsm bind theirs in their
 * types modules) and may intersect StateNode with machine-specific metadata.
 */

export type MachineEvent = { type: string };

/** A single transition candidate: guard → actions → target */
export type TransitionCandidate<S extends string> = {
	target: S;
	/** Name in the guards table */
	guard?: string;
	/** Names in the actions table */
	actions?: string[];
	/** True = fire exit/entry on self-transition (default: false = internal) */
	reenter?: boolean;
};

/** Event handler: simple target, single candidate, or ordered array (first passing guard wins) */
export type EventHandler<S extends string> =
	| S
	| TransitionCandidate<S>
	| TransitionCandidate<S>[];

/** Async service declaration — spawned on state entry, cancelled on state exit */
export type InvokeDef<S extends string> = {
	/** Name in the invokeSources table */
	src: string;
	/** Transition on successful completion */
	onDone: EventHandler<S>;
	/** Transition on error (default: stay in state) */
	onError?: EventHandler<S>;
};

/** Eventless transition — evaluated immediately on state entry after entry actions */
export type AlwaysCandidate<S extends string> = {
	target: S;
	guard?: string;
	actions?: string[];
};

/** A single state node in the machine definition */
export type StateNode<S extends string> = {
	/** Actions on entering this state */
	entry?: string[];
	/** Actions on exiting this state */
	exit?: string[];
	/** Event → transition mapping */
	on?: Record<string, EventHandler<S>>;
	/** Async service (spawned on entry, cancelled on exit) */
	invoke?: InvokeDef<S>;
	/** Eventless transitions (evaluated on entry after entry actions) */
	always?: AlwaysCandidate<S>[];
};

/** The complete machine definition: partial mapping from state path to state node */
export type MachineDefinition<S extends string> = Partial<
	Record<S, StateNode<S>>
>;

/** Tracking structure for a running invoke */
export interface ActiveInvoke {
	id: string;
	controller: AbortController;
	/** Promise that resolves when the invoke completes (for awaitAsync compatibility) */
	promise?: Promise<void>;
}

/**
 * The surface the interpreter drives. Hosts hold the state path and route
 * events; the interpreter owns transitions and invoke lifecycle.
 */
export interface MachineHost<S extends string, E extends MachineEvent> {
	/** Current state path */
	readonly statePath: S;
	/** Transition to a new state */
	setStatePath(target: S): void;
	/** Send an event to the host (re-enters its event loop) */
	send(event: E): void;
	/** Get the currently active invoke (for cancellation) */
	getActiveInvoke(): ActiveInvoke | null;
	/** Set the active invoke (for the interpreter to track) */
	setActiveInvoke(invoke: ActiveInvoke | null): void;
}

/** Guard function: returns true if the transition should proceed */
export type GuardFn<H, E> = (host: H, event: E) => boolean;

/** Action function: performs a side effect on the host */
export type ActionFn<H, E> = (host: H, event: E) => void;

/** Invoke source function: async work spawned on state entry */
export type InvokeSourceFn<H> = (
	host: H,
	signal: AbortSignal,
) => Promise<unknown>;

// =============================================================================
// Op-scoped effects
// =============================================================================
//
// A state-scoped invoke is cancelled when its state exits: its validity is
// the state. An op-scoped effect is scoped to a context entry instead — a
// per-instance async job (one per `kind:instance` id) whose completion is
// discarded when its instance is no longer live, and which survives posture
// transitions. Completions route through kind-keyed handlers independent of
// the current state.

/** Tracking structure for a running op-scoped effect */
export interface ActiveEffect {
	/** `${kind}:${instance}` */
	id: string;
	kind: string;
	instance: string;
	controller: AbortController;
	promise?: Promise<void>;
}

/** Storage for op-scoped effects; the interpreter owns its contents. */
export interface EffectsHost {
	readonly activeEffects: Map<string, ActiveEffect>;
}

/**
 * Completion candidate for an effect kind. Actions always run; a candidate
 * without a target stays in the current state (the common case — effect
 * completions usually update context, not posture).
 */
export type EffectCandidate<S extends string> = {
	target?: S;
	guard?: string;
	actions?: string[];
};

export interface EffectsConfig<S extends string, H> {
	/** Async work per effect kind, spawned by startEffect */
	sources: Record<
		string,
		(host: H, instance: string, signal: AbortSignal) => Promise<unknown>
	>;
	/** Completion routing per kind (state-independent) */
	onDone: Record<string, EffectCandidate<S> | EffectCandidate<S>[]>;
	/** Error routing per kind (default: discard) */
	onError?: Record<string, EffectCandidate<S> | EffectCandidate<S>[]>;
	/**
	 * A completion whose instance is no longer live is discarded before any
	 * handler sees it. This is the structural replacement for hand-checked
	 * staleness at every async resume point.
	 */
	isLive: (host: H, kind: string, instance: string) => boolean;
}

/** Event emitted on effect completion (`done.effect.<kind>` / `error.effect.<kind>`) */
export interface EffectEvent extends MachineEvent {
	kind: string;
	instance: string;
	data?: unknown;
}

/** Configuration for the interpreter — lookup tables for named references */
export interface InterpreterConfig<S extends string, H, E> {
	guards: Record<string, GuardFn<H, E>>;
	actions: Record<string, ActionFn<H, E>>;
	invokeSources: Record<string, InvokeSourceFn<H>>;
	effects?: EffectsConfig<S, H>;
}
