import { toMermaid, toDOT } from '../machine-visualization';
import { MACHINE } from '../machine-definition';

describe('Machine Visualization', () => {
  test('toMermaid generates valid state diagram', () => {
    const result = toMermaid(MACHINE);
    expect(result).toContain('stateDiagram-v2');
    expect(result).toContain('unloaded');
    expect(result).toContain('idle_synced');
    expect(result).toContain('active_tracking');
    // Has invoke notes
    expect(result).toContain('invoke: idle-merge');
    expect(result).toContain('invoke: cleanup');
    // Has always notes for transient states
    expect(result).toContain('transient (always)');
  });

  test('toDOT generates valid Graphviz graph', () => {
    const result = toDOT(MACHINE);
    expect(result).toContain('digraph MergeHSM');
    expect(result).toContain('unloaded');
    expect(result).toContain('idle.synced');
    expect(result).toContain('active.tracking');
    // Has subgraph clusters for state grouping
    expect(result).toContain('subgraph cluster_idle');
    expect(result).toContain('subgraph cluster_active');
  });

  test('toMermaid includes all MACHINE states', () => {
    const result = toMermaid(MACHINE);
    for (const statePath of Object.keys(MACHINE)) {
      const mermaidName = statePath.replace(/\./g, '_');
      expect(result).toContain(mermaidName);
    }
  });

  test('toDOT includes all MACHINE states', () => {
    const result = toDOT(MACHINE);
    for (const statePath of Object.keys(MACHINE)) {
      expect(result).toContain(statePath);
    }
  });
});
