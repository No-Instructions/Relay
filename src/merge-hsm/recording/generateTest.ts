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
  // Collect which factories are needed
  const usedFactories = new Set<string>();
  const needsBase64Helper = false;

  for (const entry of recording.timeline.slice(0, opts.maxEvents)) {
    const factory = getEventFactory(entry.event.type);
    if (factory) usedFactories.add(factory);
  }

  // Always need createTestHSM and expectState
  const imports = ['createTestHSM', 'expectState'];

  // Add used event factories
  const factoryImports = Array.from(usedFactories).sort();
  imports.push(...factoryImports);

  lines.push(`import {`);
  lines.push(`${i}${imports.join(',\n' + i)},`);
  lines.push(`} from '../testing';`);

  // Add base64 helper if needed for binary data
  if (recording.timeline.some(e =>
    e.event.type === 'REMOTE_UPDATE' || e.event.type === 'PERSISTENCE_LOADED'
  )) {
    lines.push('');
    lines.push(`// Helper for binary data from recordings`);
    lines.push(`function base64ToUint8Array(base64: string): Uint8Array {`);
    lines.push(`${i}const binary = atob(base64);`);
    lines.push(`${i}const bytes = new Uint8Array(binary.length);`);
    lines.push(`${i}for (let i = 0; i < binary.length; i++) {`);
    lines.push(`${i}${i}bytes[i] = binary.charCodeAt(i);`);
    lines.push(`${i}}`);
    lines.push(`${i}return bytes;`);
    lines.push(`}`);
  }
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
      lines.push(`${i}${i}expectState(t, ${JSON.stringify(entry.statePathAfter)});`);
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
    lines.push(`${i}${i}expectState(t, ${JSON.stringify(finalEntry.statePathAfter)});`);
  }

  lines.push(`${i}});`);
  lines.push(`});`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Map event types to their factory function names.
 */
function getEventFactory(eventType: string): string | null {
  const factoryMap: Record<string, string> = {
    'LOAD': 'load',
    'UNLOAD': 'unload',
    'ACQUIRE_LOCK': 'acquireLock',
    'RELEASE_LOCK': 'releaseLock',
    'DISK_CHANGED': 'diskChanged',
    'REMOTE_UPDATE': 'remoteUpdate',
    'SAVE_COMPLETE': 'saveComplete',
    'CM6_CHANGE': 'cm6Change',
    'PROVIDER_SYNCED': 'providerSynced',
    'CONNECTED': 'connected',
    'DISCONNECTED': 'disconnected',
    'RESOLVE_ACCEPT_DISK': 'resolveAcceptDisk',
    'RESOLVE_ACCEPT_LOCAL': 'resolveAcceptLocal',
    'RESOLVE_ACCEPT_MERGED': 'resolveAcceptMerged',
    'DISMISS_CONFLICT': 'dismissConflict',
    'OPEN_DIFF_VIEW': 'openDiffView',
    'CANCEL': 'cancel',
    'PERSISTENCE_LOADED': 'persistenceLoaded',
    'PERSISTENCE_SYNCED': 'persistenceSynced',
    'INITIALIZE_WITH_CONTENT': 'initializeWithContent',
    'INITIALIZE_LCA': 'initializeLCA',
    'INITIALIZE_FROM_REMOTE': 'initializeFromRemote',
    'MERGE_SUCCESS': 'mergeSuccess',
    'MERGE_CONFLICT': 'mergeConflict',
    'REMOTE_DOC_UPDATED': 'remoteDocUpdated',
    'ERROR': 'error',
  };
  return factoryMap[eventType] || null;
}

/**
 * Generate code for an event using factory functions.
 */
function generateEventCode(event: SerializableEvent, indent: string): string {
  switch (event.type) {
    case 'LOAD':
      return `load(${JSON.stringify(event.guid)}, ${JSON.stringify(event.path)})`;

    case 'UNLOAD':
      return `unload()`;

    case 'ACQUIRE_LOCK':
      return `acquireLock(${JSON.stringify(event.editorContent)})`;

    case 'RELEASE_LOCK':
      return `releaseLock()`;

    case 'PROVIDER_SYNCED':
      return `providerSynced()`;

    case 'CONNECTED':
      return `connected()`;

    case 'DISCONNECTED':
      return `disconnected()`;

    case 'RESOLVE_ACCEPT_DISK':
      return `resolveAcceptDisk()`;

    case 'RESOLVE_ACCEPT_LOCAL':
      return `resolveAcceptLocal()`;

    case 'DISMISS_CONFLICT':
      return `dismissConflict()`;

    case 'OPEN_DIFF_VIEW':
      return `openDiffView()`;

    case 'CANCEL':
      return `cancel()`;


    case 'INITIALIZE_WITH_CONTENT':
      return `initializeWithContent(${JSON.stringify(event.content)}, ${JSON.stringify(event.hash)}, ${event.mtime})`;

    case 'INITIALIZE_LCA':
      return `initializeLCA(${JSON.stringify(event.content)}, ${JSON.stringify(event.hash)}, ${event.mtime})`;

    case 'INITIALIZE_FROM_REMOTE':
      return `initializeFromRemote(${JSON.stringify(event.content)}, ${JSON.stringify(event.hash)}, ${event.mtime})`;

    case 'REMOTE_DOC_UPDATED':
      return `remoteDocUpdated()`;

    case 'DISK_CHANGED':
      return `diskChanged(\n${indent}  ${JSON.stringify(event.contents)},\n${indent}  ${event.mtime},\n${indent}  ${JSON.stringify(event.hash)}\n${indent})`;

    case 'SAVE_COMPLETE':
      return `saveComplete(${event.mtime}, ${JSON.stringify(event.hash)})`;

    case 'CM6_CHANGE':
      return `cm6Change(\n${indent}  ${JSON.stringify(event.changes)},\n${indent}  ${JSON.stringify(event.docText)},\n${indent}  ${event.isFromYjs}\n${indent})`;

    case 'RESOLVE_ACCEPT_MERGED':
      return `resolveAcceptMerged(${JSON.stringify(event.contents)})`;

    case 'REMOTE_UPDATE':
      return `remoteUpdate(base64ToUint8Array(${JSON.stringify(event.update)}))`;

    case 'PERSISTENCE_LOADED':
      return `persistenceLoaded(\n${indent}  base64ToUint8Array(${JSON.stringify(event.updates)}),\n${indent}  ${event.lca ? JSON.stringify(event.lca) : 'null'}\n${indent})`;

    case 'MERGE_SUCCESS':
      return `mergeSuccess(${JSON.stringify(event.newLCA)})`;

    case 'MERGE_CONFLICT':
      return `mergeConflict(\n${indent}  ${JSON.stringify(event.base)},\n${indent}  ${JSON.stringify(event.local)},\n${indent}  ${JSON.stringify(event.remote)}\n${indent})`;

    case 'PERSISTENCE_SYNCED':
      return `persistenceSynced(${JSON.stringify((event as any).hasContent)})`;

    case 'ERROR':
      return `error(new Error(${JSON.stringify(event.error)}))`;

    default:
      // Fallback to raw object for unknown event types
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
