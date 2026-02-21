/**
 * Machine Interpreter
 *
 * Generic interpreter for the declarative state machine definition.
 * Handles event processing, transition execution, invoke lifecycle,
 * and always-transition resolution.
 *
 * Follows XState action ordering: exit(old) → transition actions → entry(new).
 */

import type {
	StatePath,
	MergeEvent,
	MachineDefinition,
	StateNode,
	TransitionCandidate,
	EventHandler,
	InterpreterConfig,
	MachineHSM,
} from "./types";

// =============================================================================
// Main Event Processing
// =============================================================================

/**
 * Process an event through the declarative machine definition.
 *
 * @returns true if the event was handled by the machine (state is declarative),
 *          false if the state is not in the machine (caller should fall back to imperative).
 */
export function processEvent(
	hsm: MachineHSM,
	event: MergeEvent,
	machine: MachineDefinition,
	config: InterpreterConfig,
): boolean {
	const stateNode = machine[hsm.statePath];
	if (!stateNode) return false; // Not in MACHINE → fall back to imperative

	// Check invoke completion events first
	if (event.type.startsWith("done.invoke.") || event.type.startsWith("error.invoke.")) {
		const handled = handleInvokeEvent(hsm, stateNode, event, machine, config);
		if (handled) return true;
	}

	const handler = stateNode.on?.[event.type];
	if (handler === undefined) return true; // State is declarative but doesn't handle this event

	const candidates = normalizeToCandidates(handler);

	for (const candidate of candidates) {
		if (candidate.guard && !config.guards[candidate.guard](hsm, event)) continue;

		// Guard passed. Execute the transition.
		executeTransition(hsm, stateNode, candidate, event, machine, config);
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
function handleInvokeEvent(
	hsm: MachineHSM,
	stateNode: StateNode,
	event: MergeEvent,
	machine: MachineDefinition,
	config: InterpreterConfig,
): boolean {
	if (!stateNode.invoke) return false;

	const isDone = event.type.startsWith("done.invoke.");
	const isError = event.type.startsWith("error.invoke.");

	const invokeId = isDone
		? event.type.slice("done.invoke.".length)
		: event.type.slice("error.invoke.".length);

	if (stateNode.invoke.src !== invokeId) return false;

	const handler = isDone ? stateNode.invoke.onDone : stateNode.invoke.onError;
	if (!handler) return true; // No handler for this event type — consume silently

	const candidates = normalizeToCandidates(handler);

	for (const candidate of candidates) {
		if (candidate.guard && !config.guards[candidate.guard](hsm, event)) continue;

		executeTransition(hsm, stateNode, candidate, event, machine, config);
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
function executeTransition(
	hsm: MachineHSM,
	sourceNode: StateNode,
	candidate: TransitionCandidate,
	event: MergeEvent,
	machine: MachineDefinition,
	config: InterpreterConfig,
): void {
	const isSelfTransition = candidate.target === hsm.statePath;
	const isInternal = isSelfTransition && !candidate.reenter;

	if (isInternal) {
		// Internal self-transition: run transition actions ONLY, no exit/entry
		runActions(candidate.actions, hsm, event, config);
		return;
	}

	// External transition (or reenter self-transition):

	// 1. EXIT old state — cancel any running invoke, run exit actions
	cancelInvoke(hsm);
	runActions(sourceNode.exit, hsm, event, config);

	// 2. TRANSITION actions
	runActions(candidate.actions, hsm, event, config);

	// 3. ENTER new state
	hsm.setStatePath(candidate.target);
	const targetNode = machine[candidate.target];
	if (targetNode) {
		// Run entry actions
		runActions(targetNode.entry, hsm, event, config);
		// Guard: entry actions may have caused re-entrant state changes.
		// If the state is no longer the target, skip invoke/always for this node.
		if (hsm.statePath !== candidate.target) return;
		// Start invoke (if declared)
		startInvoke(hsm, targetNode, machine, config);
		// Evaluate always transitions (microstep loop)
		resolveAlwaysTransitions(hsm, event, machine, config);
	}
}

// =============================================================================
// Invoke Lifecycle
// =============================================================================

/**
 * Start an async invoke declared on a state node.
 * The invoke is tracked on the HSM and automatically cancelled when the state exits.
 */
function startInvoke(
	hsm: MachineHSM,
	stateNode: StateNode,
	machine: MachineDefinition,
	config: InterpreterConfig,
): void {
	if (!stateNode.invoke) return;

	const { src } = stateNode.invoke;
	const invokeFn = config.invokeSources[src];
	if (!invokeFn) {
		console.error(`[MergeHSM:Interpreter] Unknown invoke source: ${src}`);
		return;
	}

	const controller = new AbortController();

	const promise = invokeFn(hsm, controller.signal)
		.then((result) => {
			if (controller.signal.aborted) return; // State exited while async was running
			hsm.send({ type: `done.invoke.${src}`, data: result } as any);
		})
		.catch((error) => {
			if (controller.signal.aborted) return;
			hsm.send({ type: `error.invoke.${src}`, data: error } as any);
		});

	hsm.setActiveInvoke({ id: src, controller, promise });
}

/**
 * Cancel any running invoke on the HSM.
 */
function cancelInvoke(hsm: MachineHSM): void {
	const active = hsm.getActiveInvoke();
	if (active) {
		active.controller.abort();
		hsm.setActiveInvoke(null);
	}
}

// =============================================================================
// Always-Transition Resolution
// =============================================================================

/**
 * Evaluate always (eventless) transitions on the current state.
 * Loops until no always-transition matches or max iterations reached.
 */
function resolveAlwaysTransitions(
	hsm: MachineHSM,
	triggerEvent: MergeEvent,
	machine: MachineDefinition,
	config: InterpreterConfig,
	maxIterations = 10,
): void {
	for (let i = 0; i < maxIterations; i++) {
		const stateNode = machine[hsm.statePath];
		if (!stateNode?.always) return; // No always transitions — stable

		let matched = false;
		for (const candidate of stateNode.always) {
			if (candidate.guard && !config.guards[candidate.guard](hsm, triggerEvent)) {
				continue;
			}
			// Match found — execute transition (which may enter another state with always)
			executeTransition(
				hsm,
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
	console.error("[MergeHSM:Interpreter] Always-transition loop exceeded max iterations");
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Normalize an EventHandler into an array of TransitionCandidates.
 */
export function normalizeToCandidates(handler: EventHandler): TransitionCandidate[] {
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
function runActions(
	actionNames: string[] | undefined,
	hsm: MachineHSM,
	event: MergeEvent,
	config: InterpreterConfig,
): void {
	if (!actionNames) return;
	for (const name of actionNames) {
		const action = config.actions[name];
		if (!action) {
			console.error(`[MergeHSM:Interpreter] Unknown action: ${name}`);
			continue;
		}
		action(hsm, event);
	}
}
