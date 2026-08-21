"use strict";

/**
 * Generic interpreter for the declarative state machine definition.
 * Handles event processing, transition execution, invoke lifecycle,
 * always-transition resolution, and op-scoped effect routing.
 *
 * Follows XState action ordering: exit(old) → transition actions → entry(new).
 */

import type {
	MachineEvent,
	MachineDefinition,
	MachineHost,
	StateNode,
	TransitionCandidate,
	EventHandler,
	EffectCandidate,
	EffectEvent,
	EffectsHost,
	InterpreterConfig,
} from "./types";
import { curryLog } from "../debug";

const interpreterError = curryLog("[HSM:Interpreter]", "error");

// =============================================================================
// Main Event Processing
// =============================================================================

/**
 * Process an event through the declarative machine definition.
 *
 * @returns true if the event was handled by the machine (state is declarative),
 *          false if the state is not in the machine (caller should fall back to imperative).
 */
export function processEvent<
	S extends string,
	E extends MachineEvent,
	H extends MachineHost<S, E>,
>(
	host: H,
	event: E,
	machine: MachineDefinition<S>,
	config: InterpreterConfig<S, H, E>,
): boolean {
	// Effect completions are op-scoped, not state-scoped: route them whatever
	// the current state, live or not.
	if (
		event.type.startsWith("done.effect.") ||
		event.type.startsWith("error.effect.")
	) {
		handleEffectEvent(host, event, machine, config);
		return true;
	}

	const stateNode = machine[host.statePath];
	if (!stateNode) return false; // Not in MACHINE → fall back to imperative

	// Check invoke completion events first
	if (
		event.type.startsWith("done.invoke.") ||
		event.type.startsWith("error.invoke.")
	) {
		const handled = handleInvokeEvent(host, stateNode, event, machine, config);
		if (handled) return true;
	}

	const handler = stateNode.on?.[event.type];
	if (handler === undefined) return true; // State is declarative but doesn't handle this event

	const candidates = normalizeToCandidates(handler);

	for (const candidate of candidates) {
		if (candidate.guard && !config.guards[candidate.guard](host, event)) {
			continue;
		}

		// Guard passed. Execute the transition.
		executeTransition(host, stateNode, candidate, event, machine, config);
		return true;
	}

	return true; // Event consumed (state is declarative) but no guard passed
}

// =============================================================================
// Invoke Event Handling
// =============================================================================

/**
 * Handle `done.invoke.*` and `error.invoke.*` synthetic events.
 * These are sent by startInvoke() when an async service completes.
 */
function handleInvokeEvent<
	S extends string,
	E extends MachineEvent,
	H extends MachineHost<S, E>,
>(
	host: H,
	stateNode: StateNode<S>,
	event: E,
	machine: MachineDefinition<S>,
	config: InterpreterConfig<S, H, E>,
): boolean {
	if (!stateNode.invoke) return false;

	const isDone = event.type.startsWith("done.invoke.");

	const invokeId = isDone
		? event.type.slice("done.invoke.".length)
		: event.type.slice("error.invoke.".length);

	if (stateNode.invoke.src !== invokeId) return false;

	// The invoke has completed — clear the active invoke reference so that
	// getActiveInvoke() returns null. Without this, internal self-transitions
	// (which skip cancelInvoke) leave a stale reference that blocks hibernation.
	host.setActiveInvoke(null);

	const handler = isDone ? stateNode.invoke.onDone : stateNode.invoke.onError;
	if (!handler) return true; // No handler for this event type — consume silently

	const candidates = normalizeToCandidates(handler);

	for (const candidate of candidates) {
		if (candidate.guard && !config.guards[candidate.guard](host, event)) {
			continue;
		}

		executeTransition(host, stateNode, candidate, event, machine, config);
		return true;
	}

	return true; // Consumed but no guard passed
}

// =============================================================================
// Transition Execution
// =============================================================================

/**
 * Execute a transition following XState action ordering:
 * exit(old) → transition actions → enter(new).
 */
function executeTransition<
	S extends string,
	E extends MachineEvent,
	H extends MachineHost<S, E>,
>(
	host: H,
	sourceNode: StateNode<S>,
	candidate: TransitionCandidate<S>,
	event: E,
	machine: MachineDefinition<S>,
	config: InterpreterConfig<S, H, E>,
): void {
	const isSelfTransition = candidate.target === host.statePath;
	const isInternal = isSelfTransition && !candidate.reenter;

	if (isInternal) {
		// Internal self-transition: run transition actions ONLY, no exit/entry
		runActions(candidate.actions, host, event, config);
		return;
	}

	// External transition (or reenter self-transition):

	// 1. EXIT old state — cancel any running invoke, run exit actions.
	// Op-scoped effects are NOT cancelled here: their validity is their
	// instance's liveness, not the state that started them.
	cancelInvoke(host);
	runActions(sourceNode.exit, host, event, config);

	// 2. TRANSITION actions
	runActions(candidate.actions, host, event, config);

	// 3. ENTER new state
	host.setStatePath(candidate.target);
	const targetNode = machine[candidate.target];
	if (targetNode) {
		// Run entry actions
		runActions(targetNode.entry, host, event, config);
		// Guard: entry actions may have caused re-entrant state changes.
		// If the state is no longer the target, skip invoke/always for this node.
		if (host.statePath !== candidate.target) return;
		// Start invoke (if declared)
		startInvoke(host, targetNode, machine, config);
		// Evaluate always transitions (microstep loop)
		resolveAlwaysTransitions(host, event, machine, config);
	}
}

// =============================================================================
// Invoke Lifecycle
// =============================================================================

/**
 * Start an async invoke declared on a state node.
 * The invoke is tracked on the host and automatically cancelled when the state exits.
 */
function startInvoke<
	S extends string,
	E extends MachineEvent,
	H extends MachineHost<S, E>,
>(
	host: H,
	stateNode: StateNode<S>,
	machine: MachineDefinition<S>,
	config: InterpreterConfig<S, H, E>,
): void {
	if (!stateNode.invoke) return;

	const { src } = stateNode.invoke;
	const invokeFn = config.invokeSources[src];
	if (!invokeFn) {
		interpreterError(`Unknown invoke source: ${src}`);
		return;
	}

	const controller = new AbortController();

	const promise = invokeFn(host, controller.signal)
		.then((result) => {
			if (controller.signal.aborted) return; // State exited while async was running
			host.send({ type: `done.invoke.${src}`, data: result } as never);
		})
		.catch((error) => {
			if (controller.signal.aborted) return;
			host.send({ type: `error.invoke.${src}`, data: error } as never);
		});

	host.setActiveInvoke({ id: src, controller, promise });
}

/**
 * Cancel any running invoke on the host.
 */
function cancelInvoke<S extends string, E extends MachineEvent>(
	host: MachineHost<S, E>,
): void {
	const active = host.getActiveInvoke();
	if (active) {
		active.controller.abort();
		host.setActiveInvoke(null);
	}
}

// =============================================================================
// Op-Scoped Effect Lifecycle
// =============================================================================

function effectId(kind: string, instance: string): string {
	return `${kind}:${instance}`;
}

/**
 * Start (or restart) the effect for one instance of a kind. A second start
 * for the same `kind:instance` cancels the first: an instance owns at most
 * one effect in flight.
 */
export function startEffect<
	S extends string,
	E extends MachineEvent,
	H extends MachineHost<S, E> & EffectsHost,
>(
	host: H,
	config: InterpreterConfig<S, H, E>,
	kind: string,
	instance: string,
): void {
	const source = config.effects?.sources[kind];
	if (!source) {
		interpreterError(`Unknown effect source: ${kind}`);
		return;
	}
	cancelEffect(host, kind, instance);

	const controller = new AbortController();
	const promise = source(host, instance, controller.signal)
		.then((result) => {
			if (controller.signal.aborted) return;
			host.activeEffects.delete(effectId(kind, instance));
			host.send({
				type: `done.effect.${kind}`,
				kind,
				instance,
				data: result,
			} as never);
		})
		.catch((error) => {
			if (controller.signal.aborted) return;
			host.activeEffects.delete(effectId(kind, instance));
			host.send({
				type: `error.effect.${kind}`,
				kind,
				instance,
				data: error,
			} as never);
		});

	host.activeEffects.set(effectId(kind, instance), {
		id: effectId(kind, instance),
		kind,
		instance,
		controller,
		promise,
	});
}

/** Cancel one instance's effect. Its completion never fires. */
export function cancelEffect(
	host: EffectsHost,
	kind: string,
	instance: string,
): boolean {
	const active = host.activeEffects.get(effectId(kind, instance));
	if (!active) return false;
	active.controller.abort();
	host.activeEffects.delete(active.id);
	return true;
}

/** Cancel every in-flight effect (host teardown). */
export function cancelAllEffects(host: EffectsHost): void {
	for (const active of host.activeEffects.values()) {
		active.controller.abort();
	}
	host.activeEffects.clear();
}

/**
 * Route `done.effect.<kind>` / `error.effect.<kind>` through the config's
 * kind-keyed handlers. A completion whose instance is no longer live is
 * discarded before any handler sees it.
 */
function handleEffectEvent<
	S extends string,
	E extends MachineEvent,
	H extends MachineHost<S, E>,
>(
	host: H,
	event: E,
	machine: MachineDefinition<S>,
	config: InterpreterConfig<S, H, E>,
): void {
	const effects = config.effects;
	if (!effects) return;
	const { kind, instance } = event as MachineEvent as EffectEvent;
	if (typeof kind !== "string" || typeof instance !== "string") return;

	if (!effects.isLive(host, kind, instance)) return;

	const isDone = event.type.startsWith("done.effect.");
	const handler = (isDone ? effects.onDone : effects.onError)?.[kind];
	if (!handler) return;

	const candidates: EffectCandidate<S>[] = Array.isArray(handler)
		? handler
		: [handler];
	for (const candidate of candidates) {
		if (candidate.guard && !config.guards[candidate.guard](host, event)) {
			continue;
		}
		if (candidate.target !== undefined) {
			const sourceNode = machine[host.statePath] ?? {};
			executeTransition(
				host,
				sourceNode,
				{ target: candidate.target, actions: candidate.actions },
				event,
				machine,
				config,
			);
		} else {
			runActions(candidate.actions, host, event, config);
		}
		return;
	}
}

// =============================================================================
// Always-Transition Resolution
// =============================================================================

/**
 * Evaluate always (eventless) transitions on the current state.
 * Loops until no always-transition matches or max iterations reached.
 */
function resolveAlwaysTransitions<
	S extends string,
	E extends MachineEvent,
	H extends MachineHost<S, E>,
>(
	host: H,
	triggerEvent: E,
	machine: MachineDefinition<S>,
	config: InterpreterConfig<S, H, E>,
	maxIterations = 10,
): void {
	for (let i = 0; i < maxIterations; i++) {
		const stateNode = machine[host.statePath];
		if (!stateNode?.always) return; // No always transitions — stable

		let matched = false;
		for (const candidate of stateNode.always) {
			if (
				candidate.guard &&
				!config.guards[candidate.guard](host, triggerEvent)
			) {
				continue;
			}
			// Match found — execute transition (which may enter another state with always)
			executeTransition(
				host,
				stateNode,
				{ target: candidate.target, actions: candidate.actions },
				triggerEvent,
				machine,
				config,
			);
			matched = true;
			break;
		}
		if (!matched) return; // All guards failed — stable
	}
	interpreterError("Always-transition loop exceeded max iterations");
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Normalize an EventHandler into an array of TransitionCandidates.
 */
export function normalizeToCandidates<S extends string>(
	handler: EventHandler<S>,
): TransitionCandidate<S>[] {
	if (typeof handler === "string") {
		// Simple target string
		return [{ target: handler }];
	}
	if (Array.isArray(handler)) {
		return handler;
	}
	// Single TransitionCandidate
	return [handler];
}

/**
 * Run a list of named actions.
 */
function runActions<
	S extends string,
	E extends MachineEvent,
	H extends MachineHost<S, E>,
>(
	actionNames: string[] | undefined,
	host: H,
	event: E,
	config: InterpreterConfig<S, H, E>,
): void {
	if (!actionNames) return;
	for (const name of actionNames) {
		const action = config.actions[name];
		if (!action) {
			interpreterError(`Unknown action: ${name}`);
			continue;
		}
		action(host, event);
	}
}
