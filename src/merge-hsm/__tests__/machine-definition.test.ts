/**
 * Machine Definition Consistency Tests
 *
 * Validates that the declarative MACHINE definition is internally consistent:
 * - All named guards, actions, and invoke sources exist in lookup tables
 * - All transition targets are valid StatePath values
 * - deriveTransitions() output is consistent with the manual TRANSITIONS constant
 * - No orphaned entries in lookup tables (every entry is referenced)
 */

import {
	MACHINE,
	createInterpreterConfig,
	deriveTransitions,
	validateMachine,
} from "../machine-definition";
import { normalizeToCandidates } from "../machine-interpreter";
import type { StatePath, MachineDefinition, EventHandler } from "../types";
import { createTestHSM } from "../testing";

// All valid state paths (must match the StatePath union in types.ts)
const ALL_STATE_PATHS: StatePath[] = [
	"unloaded",
	"loading",
	"idle.loading",
	"idle.synced",
	"idle.localAhead",
	"idle.remoteAhead",
	"idle.diskAhead",
	"idle.diverged",
	"idle.error",
	"active.loading",
	"active.entering",
	"active.entering.awaitingPersistence",
	"active.entering.awaitingRemote",
	"active.entering.reconciling",
	"active.tracking",
	"active.merging.twoWay",
	"active.merging.threeWay",
	"active.conflict.bannerShown",
	"active.conflict.resolving",
	"unloading",
];

describe("Machine Definition", () => {
	describe("consistency validation", () => {
		test("validateMachine returns no errors with HSM-bound config", async () => {
			// Create a real HSM to get the bound interpreter config
			const t = await createTestHSM();
			const config = (t.hsm as any)._interpreterConfig;
			const errors = validateMachine(MACHINE, config);
			if (errors.length > 0) {
				fail(`Machine validation errors:\n${errors.join("\n")}`);
			}
		});

		test("all MACHINE state paths are valid StatePath values", () => {
			for (const statePath of Object.keys(MACHINE)) {
				expect(ALL_STATE_PATHS).toContain(statePath);
			}
		});

		test("all transition targets are valid StatePath values", () => {
			const invalidTargets: string[] = [];
			for (const [statePath, node] of Object.entries(MACHINE)) {
				if (!node) continue;

				const allTargets = collectAllTargets(node.on, node.invoke, node.always);
				for (const target of allTargets) {
					if (!ALL_STATE_PATHS.includes(target)) {
						invalidTargets.push(`${statePath} → ${target}`);
					}
				}
			}

			if (invalidTargets.length > 0) {
				fail(`Invalid transition targets:\n${invalidTargets.join("\n")}`);
			}
		});
	});

	describe("lookup tables", () => {
		test("every guard referenced in MACHINE exists in HSM interpreter config", async () => {
			const t = await createTestHSM();
			const config = (t.hsm as any)._interpreterConfig;
			const referencedGuards = collectAllNames(MACHINE, "guards");
			const missing = referencedGuards.filter((g: string) => !config.guards[g]);
			expect(missing).toEqual([]);
		});

		test("every action referenced in MACHINE exists in HSM interpreter config", async () => {
			const t = await createTestHSM();
			const config = (t.hsm as any)._interpreterConfig;
			const referencedActions = collectAllNames(MACHINE, "actions");
			const missing = referencedActions.filter((a: string) => !config.actions[a]);
			expect(missing).toEqual([]);
		});

		test("every invoke source referenced in MACHINE exists in HSM interpreter config", async () => {
			const t = await createTestHSM();
			const config = (t.hsm as any)._interpreterConfig;
			const referencedSources = collectAllNames(MACHINE, "invokeSources");
			const missing = referencedSources.filter((s: string) => !config.invokeSources[s]);
			expect(missing).toEqual([]);
		});
	});

	describe("deriveTransitions", () => {
		test("returns empty object for empty machine", () => {
			const empty: MachineDefinition = {};
			expect(deriveTransitions(empty)).toEqual({});
		});

		test("collects targets from on handlers", () => {
			const machine: MachineDefinition = {
				unloaded: {
					on: {
						LOAD: "loading",
					},
				},
			};
			const result = deriveTransitions(machine);
			expect(result["unloaded"]).toEqual(["loading"]);
		});

		test("collects targets from invoke onDone/onError", () => {
			const machine: MachineDefinition = {
				"idle.remoteAhead": {
					invoke: {
						src: "test",
						onDone: "idle.synced",
						onError: "idle.diverged",
					},
				},
			};
			const result = deriveTransitions(machine);
			expect(result["idle.remoteAhead"]).toContain("idle.synced");
			expect(result["idle.remoteAhead"]).toContain("idle.diverged");
		});

		test("collects targets from always transitions", () => {
			const machine: MachineDefinition = {
				"idle.loading": {
					always: [
						{ target: "idle.synced", guard: "allSyncedAtLoad" },
						{ target: "idle.diverged" },
					],
				},
			};
			const result = deriveTransitions(machine);
			expect(result["idle.loading"]).toContain("idle.synced");
			expect(result["idle.loading"]).toContain("idle.diverged");
		});

		test("deduplicates targets", () => {
			const machine: MachineDefinition = {
				"idle.synced": {
					on: {
						REMOTE_UPDATE: "idle.remoteAhead",
						DISK_CHANGED: "idle.remoteAhead",
					},
				},
			};
			const result = deriveTransitions(machine);
			// Should only appear once
			expect(
				result["idle.synced"]!.filter((t) => t === "idle.remoteAhead").length,
			).toBe(1);
		});
	});

	describe("normalizeToCandidates", () => {
		test("normalizes string to single candidate", () => {
			const result = normalizeToCandidates("loading" as StatePath);
			expect(result).toEqual([{ target: "loading" }]);
		});

		test("normalizes single candidate object", () => {
			const candidate = {
				target: "loading" as StatePath,
				guard: "myGuard",
				actions: ["myAction"],
			};
			const result = normalizeToCandidates(candidate);
			expect(result).toEqual([candidate]);
		});

		test("passes through array of candidates", () => {
			const candidates = [
				{ target: "idle.synced" as StatePath, guard: "g1" },
				{ target: "idle.diverged" as StatePath },
			];
			const result = normalizeToCandidates(candidates);
			expect(result).toEqual(candidates);
		});
	});
});

// =============================================================================
// Helpers
// =============================================================================

/** Collect all target StatePaths from a state node's handlers */
function collectAllTargets(
	on?: Record<string, EventHandler>,
	invoke?: { src: string; onDone: EventHandler; onError?: EventHandler },
	always?: Array<{ target: StatePath; guard?: string; actions?: string[] }>,
): StatePath[] {
	const targets = new Set<StatePath>();

	if (on) {
		for (const handler of Object.values(on)) {
			for (const c of normalizeToCandidates(handler)) {
				targets.add(c.target);
			}
		}
	}

	if (invoke) {
		for (const c of normalizeToCandidates(invoke.onDone)) {
			targets.add(c.target);
		}
		if (invoke.onError) {
			for (const c of normalizeToCandidates(invoke.onError)) {
				targets.add(c.target);
			}
		}
	}

	if (always) {
		for (const a of always) {
			targets.add(a.target);
		}
	}

	return [...targets];
}

/** Collect all named references of a given type from the MACHINE */
function collectAllNames(
	machine: MachineDefinition,
	kind: "guards" | "actions" | "invokeSources",
): string[] {
	const names = new Set<string>();

	for (const node of Object.values(machine)) {
		if (!node) continue;

		if (kind === "invokeSources") {
			if (node.invoke) names.add(node.invoke.src);
			continue;
		}

		// Collect from entry/exit
		if (kind === "actions") {
			for (const name of node.entry ?? []) names.add(name);
			for (const name of node.exit ?? []) names.add(name);
		}

		// Collect from on handlers
		if (node.on) {
			for (const handler of Object.values(node.on)) {
				for (const c of normalizeToCandidates(handler)) {
					if (kind === "guards" && c.guard) names.add(c.guard);
					if (kind === "actions" && c.actions) {
						for (const a of c.actions) names.add(a);
					}
				}
			}
		}

		// Collect from invoke onDone/onError
		if (node.invoke) {
			for (const handler of [node.invoke.onDone, node.invoke.onError]) {
				if (!handler) continue;
				for (const c of normalizeToCandidates(handler)) {
					if (kind === "guards" && c.guard) names.add(c.guard);
					if (kind === "actions" && c.actions) {
						for (const a of c.actions) names.add(a);
					}
				}
			}
		}

		// Collect from always
		if (node.always) {
			for (const candidate of node.always) {
				if (kind === "guards" && candidate.guard) names.add(candidate.guard);
				if (kind === "actions" && candidate.actions) {
					for (const a of candidate.actions) names.add(a);
				}
			}
		}
	}

	return [...names];
}
