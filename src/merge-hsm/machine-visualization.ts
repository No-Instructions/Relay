/**
 * Machine Visualization
 *
 * Generates state diagrams from the MACHINE definition for documentation
 * and debugging. Supports Mermaid and DOT (Graphviz) output formats.
 */

import type {
	StatePath,
	MachineDefinition,
	EventHandler,
	TransitionCandidate,
} from "./types";
import { normalizeToCandidates } from "./machine-interpreter";

// =============================================================================
// Types
// =============================================================================

interface Edge {
	from: StatePath;
	to: StatePath;
	label: string;
}

// =============================================================================
// Mermaid Output
// =============================================================================

/**
 * Generate a Mermaid state diagram from the MACHINE definition.
 *
 * Usage:
 *   import { MACHINE } from './machine-definition';
 *   console.log(toMermaid(MACHINE));
 *
 * Paste the output into https://mermaid.live/ or a Mermaid-enabled Markdown viewer.
 */
export function toMermaid(machine: MachineDefinition): string {
	const lines: string[] = ["stateDiagram-v2"];
	const edges = collectEdges(machine);

	// State declarations with notes for invoke/always
	for (const [statePathStr, node] of Object.entries(machine)) {
		if (!node) continue;
		const id = mermaidId(statePathStr as StatePath);

		if (node.invoke) {
			lines.push(`  note right of ${id}: invoke: ${node.invoke.src}`);
		}
		if (node.always) {
			lines.push(`  note right of ${id}: transient (always)`);
		}
	}

	// Initial state
	lines.push(`  [*] --> ${mermaidId("unloaded" as StatePath)}`);

	// Edges
	for (const edge of edges) {
		const from = mermaidId(edge.from);
		const to = mermaidId(edge.to);
		lines.push(`  ${from} --> ${to}: ${edge.label}`);
	}

	return lines.join("\n");
}

/** Convert a StatePath to a valid Mermaid state ID */
function mermaidId(statePath: StatePath): string {
	return statePath.replace(/\./g, "_");
}

// =============================================================================
// DOT (Graphviz) Output
// =============================================================================

/**
 * Generate a DOT graph from the MACHINE definition.
 *
 * Usage:
 *   import { MACHINE } from './machine-definition';
 *   console.log(toDOT(MACHINE));
 *
 * Render with: dot -Tsvg -o hsm.svg <<< "$(node -e '...')"
 */
export function toDOT(machine: MachineDefinition): string {
	const lines: string[] = [
		"digraph MergeHSM {",
		"  rankdir=TB;",
		'  node [shape=box, style=rounded, fontname="Helvetica", fontsize=10];',
		'  edge [fontname="Helvetica", fontsize=8];',
		"",
	];

	const edges = collectEdges(machine);

	// Cluster states by prefix
	const clusters = groupByPrefix(Object.keys(machine) as StatePath[]);

	for (const [prefix, states] of Object.entries(clusters)) {
		if (prefix === "") {
			// Top-level states
			for (const s of states) {
				lines.push(`  ${dotId(s)} [label="${s}"${dotStyle(s, machine)}];`);
			}
		} else {
			lines.push(`  subgraph cluster_${prefix.replace(/\./g, "_")} {`);
			lines.push(`    label="${prefix}";`);
			lines.push('    style=dashed;');
			lines.push('    color="#666666";');
			for (const s of states) {
				lines.push(`    ${dotId(s)} [label="${s}"${dotStyle(s, machine)}];`);
			}
			lines.push("  }");
		}
	}

	lines.push("");

	// Edges
	for (const edge of edges) {
		lines.push(`  ${dotId(edge.from)} -> ${dotId(edge.to)} [label="${dotEscape(edge.label)}"];`);
	}

	lines.push("}");
	return lines.join("\n");
}

/** Convert a StatePath to a valid DOT node ID */
function dotId(statePath: StatePath): string {
	return `"${statePath}"`;
}

/** Escape special characters for DOT labels */
function dotEscape(s: string): string {
	return s.replace(/"/g, '\\"');
}

/** Add visual styling for special state types */
function dotStyle(statePath: StatePath, machine: MachineDefinition): string {
	const node = machine[statePath];
	if (!node) return "";
	if (node.invoke) return ', fillcolor="#e8f4fd", style="rounded,filled"';
	if (node.always) return ', fillcolor="#fff3cd", style="rounded,filled"';
	return "";
}

// =============================================================================
// Edge Collection
// =============================================================================

/** Collect all edges from the MACHINE definition */
function collectEdges(machine: MachineDefinition): Edge[] {
	const edges: Edge[] = [];

	for (const [statePathStr, node] of Object.entries(machine)) {
		if (!node) continue;
		const from = statePathStr as StatePath;

		// Edges from `on` handlers
		if (node.on) {
			for (const [eventType, handler] of Object.entries(node.on)) {
				const targets = uniqueTargets(handler);
				for (const to of targets) {
					edges.push({ from, to, label: eventType });
				}
			}
		}

		// Edges from `invoke`
		if (node.invoke) {
			const doneTargets = uniqueTargets(node.invoke.onDone);
			for (const to of doneTargets) {
				edges.push({ from, to, label: `done(${node.invoke.src})` });
			}
			if (node.invoke.onError) {
				const errorTargets = uniqueTargets(node.invoke.onError);
				for (const to of errorTargets) {
					edges.push({ from, to, label: `error(${node.invoke.src})` });
				}
			}
		}

		// Edges from `always`
		if (node.always) {
			for (const candidate of node.always) {
				const label = candidate.guard ? `[${candidate.guard}]` : "[else]";
				edges.push({ from, to: candidate.target, label });
			}
		}
	}

	return edges;
}

/** Get unique target states from an EventHandler */
function uniqueTargets(handler: EventHandler): StatePath[] {
	const candidates = normalizeToCandidates(handler);
	const targets = new Set<StatePath>();
	for (const c of candidates) {
		targets.add(c.target);
	}
	return [...targets];
}

// =============================================================================
// Helpers
// =============================================================================

/** Group state paths by their prefix (for DOT subgraph clusters) */
function groupByPrefix(states: StatePath[]): Record<string, StatePath[]> {
	const groups: Record<string, StatePath[]> = {};

	for (const s of states) {
		const parts = s.split(".");
		let prefix = "";
		if (parts.length > 1) {
			prefix = parts[0];
			// For deeply nested states like "active.entering.awaitingPersistence",
			// cluster by the first two segments
			if (parts.length > 2) {
				prefix = parts.slice(0, 2).join(".");
			}
		}
		if (!groups[prefix]) groups[prefix] = [];
		groups[prefix].push(s);
	}

	return groups;
}
