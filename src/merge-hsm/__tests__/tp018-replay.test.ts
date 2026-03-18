/**
 * TP-018 Recording Replay
 *
 * Replays the exact user input events from the TP-018 E2E recording
 * against the full cross-vault digital twin with provider integration.
 *
 * SYSTEM events (REMOTE_UPDATE, PROVIDER_SYNCED, CONNECTED, etc.) are
 * NOT replayed — they should emerge naturally from the provider integration.
 * If the twin's integration layer produces different system events than
 * production, the state transitions will diverge from the recording.
 *
 * This is the trust test: if the twin produces the same state transitions
 * as the recording for the same user inputs, the twin is faithful.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as Y from 'yjs';
import { createCrossVaultTest } from '../testing/createCrossVaultTest';
import type { CrossVaultTest } from '../testing/createCrossVaultTest';
import { deserializeEvent } from '../recording/serialization';

const FIXTURES_DIR = path.resolve(__dirname, '../../../hsm-conflict-fixtures');

const BASE = '# Conflict Test\n\nLine 1: Original content\nLine 2: This line will be edited\nLine 3: More original content\n';

interface RecordedEvent {
  vault: 'A' | 'B';
  seq: number;
  type: string;
  from: string;
  to: string;
  event: Record<string, any>;
}

// Events that we replay as user/lifecycle inputs
const INPUT_TYPES = new Set([
  'LOAD', 'PERSISTENCE_LOADED', 'SET_MODE_IDLE', 'SET_MODE_ACTIVE',
  'DISK_CHANGED', 'ACQUIRE_LOCK', 'RELEASE_LOCK',
  'CM6_CHANGE', 'OPEN_DIFF_VIEW', 'RESOLVE',
  'DISMISS_CONFLICT', 'CANCEL', 'RESOLVE_HUNK',
  'UNLOAD',
]);

// Events produced by the integration layer — NOT replayed
const SYSTEM_TYPES = new Set([
  'PERSISTENCE_SYNCED', 'PROVIDER_SYNCED', 'CONNECTED', 'DISCONNECTED',
  'REMOTE_UPDATE', 'REMOTE_DOC_UPDATED', 'SAVE_COMPLETE',
  'MERGE_SUCCESS', 'MERGE_CONFLICT',
]);

const inputsFile = path.join(FIXTURES_DIR, 'tp018-inputs.json');

describe('TP-018 Recording Replay', () => {

  if (!fs.existsSync(inputsFile)) {
    test.skip('tp018-inputs.json not found', () => {});
    return;
  }

  const allRecorded: RecordedEvent[] = JSON.parse(fs.readFileSync(inputsFile, 'utf-8'));

  test('replay user inputs through provider integration, verify state transitions', async () => {
    const ctx = await createCrossVaultTest({ useProviderIntegration: true });

    // Seed both vaults' mock IndexedDB with the base content.
    // In production, this was persisted from a previous session.
    // This must match what PERSISTENCE_LOADED carries.
    const seedDoc = new Y.Doc();
    seedDoc.getText('contents').insert(0, BASE);
    const seedUpdate = Y.encodeStateAsUpdate(seedDoc);
    seedDoc.destroy();
    // Seed both vaults' IDB with multi-client content.
    // In production, the document was enrolled via diff_match_patch
    // which creates ops under multiple client IDs. This is critical
    // for reproducing BUG-123: partial sync loses client 2's ops.
    //
    // Client 1: skeleton (without line 2 text)
    // Client 2: line 2 text (inserted separately, like machine edit)
    const doc1 = new Y.Doc();
    doc1.getText('contents').insert(0,
      '# Conflict Test\n\nLine 1: Original content\n\nLine 3: More original content\n');
    const client1Update = Y.encodeStateAsUpdate(doc1);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, client1Update);
    const t2 = doc2.getText('contents');
    const line1End = t2.toString().indexOf('\n', t2.toString().indexOf('Line 1'));
    t2.delete(line1End + 1, 1);
    t2.insert(line1End + 1, 'Line 2: This line will be edited\n');
    const multiClientUpdate = Y.encodeStateAsUpdate(doc2);
    doc1.destroy();
    doc2.destroy();

    ctx.vaultA.hsm.seedIndexedDB(multiClientUpdate);
    ctx.vaultB.hsm.seedIndexedDB(multiClientUpdate);
    // Seed server with client 1 only — matching production where the
    // server also received partial enrollment state via the provider
    // (same wsReady timing issue during initial enrollment).
    Y.applyUpdate(ctx.server, client1Update, 'enrollment');
    // Seed A's remoteDoc with full state (will be replaced on reconnect)
    ctx.vaultA.hsm.syncRemoteWithUpdate(multiClientUpdate);
    // Seed B's remoteDoc with PARTIAL state (client 1 only) to match
    // production where the provider delivers incomplete initial sync.
    // This is the sender-side root cause: B's SyncBridge applies deltas
    // against a partial remoteDoc, producing updates that don't include
    // the delete of client 2's items.
    ctx.vaultB.hsm.syncRemoteWithUpdate(client1Update);

    // Track all state transitions for comparison
    const transitionsA: Array<{ event: string; from: string; to: string }> = [];
    const transitionsB: Array<{ event: string; from: string; to: string }> = [];

    ctx.vaultA.hsm.hsm.onStateChange((from, to, event) => {
      transitionsA.push({ event: event.type, from, to });
    });
    ctx.vaultB.hsm.hsm.onStateChange((from, to, event) => {
      transitionsB.push({ event: event.type, from, to });
    });

    const divergences: string[] = [];
    let capturedConflictData: any = null;
    let capturedDocContent: any = null;

    for (const recorded of allRecorded) {
      const { vault, seq, type: eventType, from: expectedFrom, to: expectedTo } = recorded;
      const vaultHandle = vault === 'A' ? ctx.vaultA : ctx.vaultB;

      // Skip system events — these should come from the integration layer
      if (SYSTEM_TYPES.has(eventType)) {
        // But verify the twin reached the expected post-state
        // (it may have gotten there via a different path)
        continue;
      }

      // Skip invoke completions — produced internally
      if (eventType.startsWith('done.invoke') || eventType.startsWith('error.invoke')) {
        continue;
      }

      // Handle recording gaps: if the twin is not in the expected
      // pre-state, check if we need to inject a missing UNLOAD
      // (from send() re-entrancy recording bug)
      const actualFrom = vaultHandle.hsm.statePath;
      // Tolerate fast-path for pre-state too
      const preStateFastPath =
        (expectedFrom === 'active.entering.awaitingPersistence' && (actualFrom === 'active.tracking' || actualFrom === 'active.conflict.bannerShown'));
      if (actualFrom !== expectedFrom && !preStateFastPath) {
        if (expectedFrom === 'unloaded' && actualFrom !== 'unloaded') {
          // Recording gap: an UNLOAD was dropped. Inject it.
          vaultHandle.send({ type: 'UNLOAD' });
          try { await vaultHandle.hsm.hsm.awaitCleanup(); } catch {}
          await new Promise(r => setTimeout(r, 10));
        }

        // Re-check after gap bridging
        const newActual = vaultHandle.hsm.statePath;
        if (newActual !== expectedFrom) {
          divergences.push(
            `${vault} seq ${seq} (${eventType}): pre-state ` +
            `expected=${expectedFrom}, actual=${newActual}`
          );
          if (divergences.length >= 10) break;
          continue; // skip this event to avoid cascading errors
        }
      }

      // Patch PERSISTENCE_LOADED events: the recording may have null LCA
      // due to the send() re-entrancy recording bug, but production had
      // the LCA from a previous session. Extract it from the PERSIST_STATE
      // effect at seq 3 (which shows the LCA after first DISK_CHANGED).
      let eventToSend = recorded.event;
      if (eventType === 'PERSISTENCE_LOADED' && !eventToSend.lca) {
        // The recording may show null LCA due to the send() re-entrancy
        // recording bug, but production had the LCA from a previous session.
        // Inject it directly as a runtime MergeEvent (bypassing deserialize).
        // Use the multi-client update (matches what was persisted in IDB)
        const updates = multiClientUpdate;
        const tempDoc = new Y.Doc();
        Y.applyUpdate(tempDoc, multiClientUpdate);
        const sv = Y.encodeStateVector(tempDoc);
        tempDoc.destroy();
        vaultHandle.send({
          type: 'PERSISTENCE_LOADED',
          updates,
          lca: {
            contents: BASE,
            meta: {
              hash: 'af501373038f64c3eb2d2ac6bc4502a2fa3580e9fee8147741223215fe31b395',
              mtime: 1773853530960,
            },
            stateVector: sv,
          },
        });
        // Skip the normal deserialize+send below
        // (post-state check follows)
        const actualTo2 = vaultHandle.hsm.statePath;
        if (actualTo2 !== expectedTo) {
          divergences.push(
            `${vault} seq ${seq} (${eventType}): post-state ` +
            `expected=${expectedTo}, actual=${actualTo2}`
          );
        }
        continue;
      }

      // Replay the input event
      try {
        const mergeEvent = deserializeEvent(eventToSend as any);
        vaultHandle.send(mergeEvent);
      } catch (err: any) {
        divergences.push(
          `${vault} seq ${seq} (${eventType}): CRASH — ${err.message}`
        );
        break;
      }

      // Wait for async operations to settle
      if (eventType === 'RELEASE_LOCK') {
        try { await vaultHandle.hsm.hsm.awaitCleanup(); } catch {}
      }
      if (eventType === 'DISK_CHANGED') {
        if (vault === 'A' && seq === 16) {
          // A's disk edit: the idle-merge creates a fork. Reconnect
          // immediately so B's edits arrive while the fork is active.
          // This matches production timing (REMOTE_UPDATE 2s after
          // DISK_CHANGED, before fork-reconcile completes).
          //
          // BUG-123 reproduction: reuse the OLD provider (matching
          // production's Document.ts which returns this._provider).
          // The old provider's internal doc still references the old
          // remoteDoc, so sync delivers partial CRDT state.
          // Let idle-merge create the fork first
          await new Promise(r => setTimeout(r, 20));
          try { await vaultHandle.hsm.awaitIdleAutoMerge(); } catch {}

          // Reconnect A with a NEW provider (matching production's
          // ensureRemoteDoc which creates new _ydoc + _provider pair).
          // The new provider syncs server state (blank line 2) into
          // the fresh remoteDoc.
          ctx.vaultA.reconnect();

          // Wait for fork-reconcile to settle
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 20));
            const s = ctx.vaultA.hsm.statePath;
            if (s !== 'idle.localAhead' && s !== 'idle.diskAhead') break;
          }
        } else {
          // Normal DISK_CHANGED: let idle-merge settle
          await new Promise(r => setTimeout(r, 20));
          try { await vaultHandle.hsm.awaitIdleAutoMerge(); } catch {}
        }
      }

      // Match production timing: disconnect A after RELEASE_LOCK so A
      // doesn't receive B's edits in real-time. In production, A's
      // REMOTE_UPDATE at seq 14 was a noop (baseline re-delivery), and
      // B's actual edit only arrives when A reconnects after the disk edit.
      if (vault === 'A' && eventType === 'RELEASE_LOCK' && seq === 12) {
        ctx.vaultA.disconnect();
      }
      // Reconnect A after A's disk edit creates a fork
      // (matches recording: A seq 19 REMOTE_UPDATE arrives after fork)
      if (vault === 'A' && eventType === 'DISK_CHANGED' && seq === 16) {
        const st = ctx.vaultA.hsm.hsm.state;
        console.log('[A at seq 16]', {
          preState: ctx.vaultA.hsm.statePath,
          lcaHash: st.lca?.meta?.hash?.slice(0,12),
          eventHash: (recorded.event as any).hash?.slice(0,12),
        });
      }

      // Capture conflictData AND doc-content state when A reaches bannerShown
      // (matches TP-018 step 1.5.1 checkpoint — before resolution)
      if (vault === 'A' && ctx.vaultA.hsm.statePath === 'active.conflict.bannerShown' && !capturedConflictData) {
        capturedConflictData = ctx.vaultA.hsm.hsm.getConflictData();
        capturedDocContent = {
          server: ctx.server.getText('contents').toString(),
          serverClients: Y.decodeStateVector(Y.encodeStateVector(ctx.server)).size,
          local: ctx.vaultA.hsm.hsm.getLocalDoc()?.getText('contents').toString() ?? '',
          remote: ctx.vaultA.hsm.hsm.getRemoteDoc()?.getText('contents').toString() ?? '',
        };
      }

      // Connect A's provider when A reaches active.tracking
      if (vault === 'A' && vaultHandle.hsm.statePath === 'active.tracking' && !ctx.vaultA.provider?.synced) {
        ctx.vaultA.provider?.connect();
      }
      // B's provider: connect AFTER B closes the file (RELEASE_LOCK).
      // In production, Document.connect() is async — the WebSocket opens
      // AFTER B starts typing. The y-websocket provider's broadcastMessage
      // silently drops updates when wsconnected is false. By the time the
      // WebSocket opens, B has already finished editing. The deferred sync
      // pulls server state but doesn't replay the dropped outbound updates.
      if (vault === 'B' && eventType === 'RELEASE_LOCK' && !ctx.vaultB.provider?.synced) {
        ctx.vaultB.provider?.connect();
      }

      // Let deferred provider sync fire between events
      await new Promise(r => setTimeout(r, 5));

      // Check post-state
      const actualTo = vaultHandle.hsm.statePath;

      // Tolerate fast-path: mock persistence syncs synchronously so the
      // twin skips active.entering.awaitingPersistence → active.tracking.
      // This is functionally equivalent — the twin just doesn't pause.
      const fastPathOk =
        (expectedTo === 'active.entering.awaitingPersistence' && actualTo === 'active.tracking') ||
        (expectedTo === 'active.entering.awaitingPersistence' && actualTo === 'active.conflict.bannerShown') ||
        (expectedTo === 'unloading' && actualTo === 'idle.synced') ||
        (expectedTo === 'unloading' && actualTo === 'idle.diverged') ||
        // Twin's remote SV may differ from production's due to provider
        // sync timing — both idle.diskAhead and idle.diverged lead to
        // fork creation via idle-merge
        (expectedTo === 'idle.diskAhead' && actualTo === 'idle.diverged');

      if (actualTo !== expectedTo && !fastPathOk) {
        // Debug: print HSM state at first divergence
        if (divergences.length === 0) {
          const state = vaultHandle.hsm.hsm.state;
          console.log(`\n=== FIRST DIVERGENCE DEBUG ===`);
          console.log(`  ${vault} seq ${seq} (${eventType})`);
          console.log(`  expected: ${expectedFrom} -> ${expectedTo}`);
          console.log(`  actual:   ${actualFrom} -> ${actualTo}`);
          console.log(`  lca: ${state.lca ? JSON.stringify({hash: state.lca.meta?.hash?.slice(0,12), contents: state.lca.contents?.slice(0,40)}) : 'null'}`);
          console.log(`  disk: ${state.disk ? JSON.stringify(state.disk) : 'null'}`);
          console.log(`  localSV len: ${state.localStateVector?.length ?? 'null'}`);
          console.log(`  remoteSV len: ${state.remoteStateVector?.length ?? 'null'}`);
          console.log(`  fork: ${state.fork ? 'present' : 'null'}`);
          console.log(`  isOnline: ${state.isOnline}`);
          console.log(`  conflictData: ${vaultHandle.hsm.hsm.getConflictData() ? 'present' : 'null'}`);
          // Print recent transitions
          const trans = vault === 'A' ? transitionsA : transitionsB;
          console.log(`  recent transitions:`);
          for (const t of trans.slice(-5)) {
            console.log(`    ${t.event}: ${t.from} -> ${t.to}`);
          }
        }
        divergences.push(
          `${vault} seq ${seq} (${eventType}): post-state ` +
          `expected=${expectedTo}, actual=${actualTo}`
        );
        if (divergences.length >= 10) break;
      }
    }

    // Report
    if (divergences.length > 0) {
      console.log(`\n=== ${divergences.length} DIVERGENCE(S) ===`);
      for (const d of divergences) {
        console.log(`  ${d}`);
      }
    }

    expect(divergences.length).toBe(0);

    // === doc-content state assertions ===
    //
    // Compare the twin's state against the production doc-content snapshot
    // (tp017-doc-content-after-conflict.json). This is the ground truth
    // from the actual TP-017 run.
    //
    // Production snapshot at conflict detection:
    //   local.content:  "...LOCAL DISK EDIT from live1..."
    //   remote.content: "...\n\nLine 3:..." (line 2 blank)
    //   server.content: "...\n\nLine 3:..." (line 2 blank)
    //
    // The twin should match this EXACT state at the conflict point.

    // Use doc-content captured at the conflict detection point (step 1.5.1)
    expect(capturedDocContent).not.toBeNull();

    const prodSnapshot = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'tp017-doc-content-after-conflict.json'), 'utf-8')
    );

    // Exact match: local content
    expect(capturedDocContent.local).toBe(prodSnapshot.local.content);

    // Exact match: server content (blank line 2, single client)
    expect(capturedDocContent.server).toBe(prodSnapshot.server.content);
    expect(capturedDocContent.serverClients).toBe(1);

    // Exact match: remote content (same as server)
    expect(capturedDocContent.remote).toBe(prodSnapshot.remote.content);

    // === TP-018 pass criteria (step 1.5.1 + step 3.2) ===
    // These assert CORRECT behavior. They FAIL when BUG-123 is present.

    // Step 1.5.1: server MUST have B's edit
    expect(capturedDocContent.server).toContain('REMOTE EDIT from live2');

    // Step 3.2: conflictData.theirs MUST have remote content
    expect(capturedConflictData).not.toBeNull();
    expect(capturedConflictData.ours).toContain('LOCAL DISK EDIT from live1');
    expect(capturedConflictData.theirs).toContain('REMOTE EDIT from live2');

    ctx.destroy();
  });
});
