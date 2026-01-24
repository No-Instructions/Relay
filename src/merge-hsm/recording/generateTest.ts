/**
 * Recording to Unit Test Generator
 *
 * Converts HSM recordings into Jest unit tests.
 *
 * Usage:
 *   npx ts-node src/merge-hsm/recording/generateTest.ts recording.json output.test.ts
 *
 * Or programmatically:
 *   import { generateTestFromRecording } from './generateTest';
 *   const testCode = generateTestFromRecording(recording, { testName: 'my test' });
 */

import type { HSMRecording, HSMTimelineEntry, SerializableEvent, SerializableEffect } from './types';
import { deserializeRecording } from './serialization';

// =============================================================================
// Types
// =============================================================================

export interface GenerateTestOptions {
  /** Test name (default: recording name) */
  testName?: string;

  /** Test description */
  description?: string;

  /** Include snapshots in assertions */
  includeSnapshots?: boolean;

  /** Include effect assertions */
  assertEffects?: boolean;

  /** Include state transition assertions */
  assertTransitions?: boolean;

  /** Maximum events to include (for very long recordings) */
  maxEvents?: number;

  /** Indent string (default: '  ') */
  indent?: string;
}

const DEFAULT_OPTIONS: Required<GenerateTestOptions> = {
  testName: '',
  description: '',
  includeSnapshots: false,
  assertEffects: true,
  assertTransitions: true,
  maxEvents: 100,
  indent: '  ',
};

// =============================================================================
// Generator
// =============================================================================

/**
 * Generate a Jest test file from an HSM recording.
 */
export function generateTestFromRecording(
  recording: HSMRecording,
  options: GenerateTestOptions = {}
): string {
  const opts: Required<GenerateTestOptions> = { ...DEFAULT_OPTIONS, ...options };
  if (!opts.testName) {
    opts.testName = recording.name || `Recording ${recording.id}`;
  }

  const lines: string[] = [];
  const i = opts.indent;

  // Imports
  lines.push(`/**`);
  lines.push(` * Auto-generated test from HSM recording: ${recording.id}`);
  lines.push(` * Recording name: ${recording.name}`);
  lines.push(` * Source: ${recording.metadata.source}`);
  if (recording.metadata.testName) {
    lines.push(` * Original test: ${recording.metadata.testName}`);
  }
  lines.push(` * Generated at: ${new Date().toISOString()}`);
  lines.push(` */`);
  lines.push('');
  lines.push(`import { createTestHSM } from '../testing';`);
  lines.push(`import type { MergeEvent } from '../types';`);
  lines.push('');

  // Test describe block
  lines.push(`describe('${escapeString(opts.testName)}', () => {`);

  // Single test case
  lines.push(`${i}it('replays recording correctly', () => {`);

  // Setup
  lines.push(`${i}${i}// Initial state: ${recording.initialState.statePath}`);
  lines.push(`${i}${i}const t = createTestHSM({`);
  lines.push(`${i}${i}${i}guid: ${JSON.stringify(recording.document.guid)},`);
  lines.push(`${i}${i}${i}path: ${JSON.stringify(recording.document.path)},`);
  lines.push(`${i}${i}${i}initialState: ${JSON.stringify(recording.initialState.statePath)},`);

  // Include initial content if available
  if (recording.initialState.snapshot.localDocText !== null) {
    lines.push(`${i}${i}${i}localDoc: ${JSON.stringify(recording.initialState.snapshot.localDocText)},`);
  }

  lines.push(`${i}${i}});`);
  lines.push('');

  // Events
  const timeline = recording.timeline.slice(0, opts.maxEvents);

  for (let idx = 0; idx < timeline.length; idx++) {
    const entry = timeline[idx];
    lines.push(`${i}${i}// Event ${idx + 1}: ${entry.event.type}`);

    // Generate event
    const eventCode = generateEventCode(entry.event, i + i);
    lines.push(`${i}${i}t.send(${eventCode});`);

    // Assert state transition
    if (opts.assertTransitions) {
      lines.push(`${i}${i}expect(t.statePath).toBe(${JSON.stringify(entry.statePathAfter)});`);
    }

    // Assert effects (simplified - just count)
    if (opts.assertEffects && entry.effects.length > 0) {
      const effectTypes = entry.effects.map(e => e.type);
      const uniqueTypes = [...new Set(effectTypes)];
      for (const type of uniqueTypes) {
        const count = effectTypes.filter(t => t === type).length;
        lines.push(`${i}${i}expect(t.effects.filter(e => e.type === '${type}').length).toBeGreaterThanOrEqual(${count});`);
      }
      lines.push(`${i}${i}t.clearEffects();`);
    }

    lines.push('');
  }

  // Final assertions
  lines.push(`${i}${i}// Final state`);
  const finalEntry = timeline[timeline.length - 1];
  if (finalEntry) {
    lines.push(`${i}${i}expect(t.statePath).toBe(${JSON.stringify(finalEntry.statePathAfter)});`);
  }

  lines.push(`${i}});`);
  lines.push(`});`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate code for an event.
 */
function generateEventCode(event: SerializableEvent, indent: string): string {
  switch (event.type) {
    case 'LOAD':
      return `{ type: 'LOAD', guid: ${JSON.stringify(event.guid)}, path: ${JSON.stringify(event.path)} }`;

    case 'UNLOAD':
    case 'ACQUIRE_LOCK':
    case 'RELEASE_LOCK':
    case 'PROVIDER_SYNCED':
    case 'CONNECTED':
    case 'DISCONNECTED':
    case 'RESOLVE_ACCEPT_DISK':
    case 'RESOLVE_ACCEPT_LOCAL':
    case 'DISMISS_CONFLICT':
    case 'OPEN_DIFF_VIEW':
    case 'CANCEL':
    case 'YDOCS_READY':
    case 'REMOTE_DOC_UPDATED':
      return `{ type: '${event.type}' }`;

    case 'DISK_CHANGED':
      return `{\n${indent}  type: 'DISK_CHANGED',\n${indent}  contents: ${JSON.stringify(event.contents)},\n${indent}  mtime: ${event.mtime},\n${indent}  hash: ${JSON.stringify(event.hash)}\n${indent}}`;

    case 'SAVE_COMPLETE':
      return `{ type: 'SAVE_COMPLETE', mtime: ${event.mtime} }`;

    case 'CM6_CHANGE':
      return `{\n${indent}  type: 'CM6_CHANGE',\n${indent}  changes: ${JSON.stringify(event.changes)},\n${indent}  docText: ${JSON.stringify(event.docText)},\n${indent}  isFromYjs: ${event.isFromYjs}\n${indent}}`;

    case 'RESOLVE_ACCEPT_MERGED':
      return `{ type: 'RESOLVE_ACCEPT_MERGED', contents: ${JSON.stringify(event.contents)} }`;

    case 'REMOTE_UPDATE':
      // Base64 update - need to convert back
      return `{ type: 'REMOTE_UPDATE', update: base64ToUint8Array(${JSON.stringify(event.update)}) }`;

    case 'PERSISTENCE_LOADED':
      return `{\n${indent}  type: 'PERSISTENCE_LOADED',\n${indent}  updates: base64ToUint8Array(${JSON.stringify(event.updates)}),\n${indent}  lca: ${event.lca ? JSON.stringify(event.lca) : 'null'}\n${indent}}`;

    case 'MERGE_SUCCESS':
      return `{ type: 'MERGE_SUCCESS', newLCA: ${JSON.stringify(event.newLCA)} }`;

    case 'MERGE_CONFLICT':
      return `{\n${indent}  type: 'MERGE_CONFLICT',\n${indent}  base: ${JSON.stringify(event.base)},\n${indent}  local: ${JSON.stringify(event.local)},\n${indent}  remote: ${JSON.stringify(event.remote)}\n${indent}}`;

    case 'ERROR':
      return `{ type: 'ERROR', error: new Error(${JSON.stringify(event.error)}) }`;

    default:
      return JSON.stringify(event);
  }
}

function escapeString(str: string): string {
  return str.replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

// =============================================================================
// CLI
// =============================================================================

/**
 * Run as CLI.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: npx ts-node generateTest.ts <recording.json> [output.test.ts]');
    console.log('');
    console.log('Options (via env vars):');
    console.log('  TEST_NAME=<name>       Override test name');
    console.log('  MAX_EVENTS=<number>    Max events to include');
    console.log('  NO_EFFECTS=1           Skip effect assertions');
    console.log('  NO_TRANSITIONS=1       Skip state transition assertions');
    process.exit(1);
  }

  const inputPath = args[0];
  const outputPath = args[1];

  // Load recording
  const fs = await import('fs');
  const json = fs.readFileSync(inputPath, 'utf-8');
  const recording = deserializeRecording(json);

  // Options from env
  const options: GenerateTestOptions = {
    testName: process.env.TEST_NAME,
    maxEvents: process.env.MAX_EVENTS ? parseInt(process.env.MAX_EVENTS) : undefined,
    assertEffects: process.env.NO_EFFECTS !== '1',
    assertTransitions: process.env.NO_TRANSITIONS !== '1',
  };

  // Generate
  const testCode = generateTestFromRecording(recording, options);

  // Output
  if (outputPath) {
    fs.writeFileSync(outputPath, testCode);
    console.log(`Generated test: ${outputPath}`);
  } else {
    console.log(testCode);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
