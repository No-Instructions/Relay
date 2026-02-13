/**
 * Tests for HSM Recording Infrastructure
 */

import {
  replayLogEntries,
  filterLogEntries,
  sliceLogEntries,
  findLogTransition,
  serializeEvent,
  deserializeEvent,
  serializeEffect,
  deserializeEffect,
  uint8ArrayToBase64,
  base64ToUint8Array,
  E2ERecordingBridge,
} from '../recording';
import type { HSMLogEntry, ReplayResult } from '../recording';
import { createTestHSM, cm6Insert, diskChanged, acquireLock, loadAndActivate, loadToIdle } from '../testing';
import type { MergeEvent, MergeEffect, RemoteUpdateEvent } from '../types';

describe('HSM Recording', () => {
  describe('Base64 Encoding', () => {
    it('encodes and decodes Uint8Array correctly', () => {
      const original = new Uint8Array([0, 1, 2, 255, 128, 64]);
      const encoded = uint8ArrayToBase64(original);
      const decoded = base64ToUint8Array(encoded);

      expect(decoded).toEqual(original);
    });

    it('handles empty array', () => {
      const original = new Uint8Array([]);
      const encoded = uint8ArrayToBase64(original);
      const decoded = base64ToUint8Array(encoded);

      expect(decoded).toEqual(original);
    });

    it('handles large arrays', () => {
      const original = new Uint8Array(10000);
      for (let i = 0; i < original.length; i++) {
        original[i] = i % 256;
      }
      const encoded = uint8ArrayToBase64(original);
      const decoded = base64ToUint8Array(encoded);

      expect(decoded).toEqual(original);
    });
  });

  describe('Event Serialization', () => {
    it('serializes and deserializes REMOTE_UPDATE event', () => {
      const event: RemoteUpdateEvent = {
        type: 'REMOTE_UPDATE',
        update: new Uint8Array([1, 2, 3, 4, 5]),
      };

      const serialized = serializeEvent(event);
      expect(serialized.type).toBe('REMOTE_UPDATE');
      expect(typeof (serialized as any).update).toBe('string'); // base64

      const deserialized = deserializeEvent(serialized) as RemoteUpdateEvent;
      expect(deserialized.type).toBe('REMOTE_UPDATE');
      expect(deserialized.update).toEqual(event.update);
    });

    it('serializes and deserializes CM6_CHANGE event', () => {
      const event: MergeEvent = {
        type: 'CM6_CHANGE',
        changes: [{ from: 0, to: 5, insert: 'hello' }],
        docText: 'hello world',
        isFromYjs: false,
      };

      const serialized = serializeEvent(event);
      const deserialized = deserializeEvent(serialized);

      expect(deserialized).toEqual(event);
    });

    it('serializes and deserializes ERROR event', () => {
      const event: MergeEvent = {
        type: 'ERROR',
        error: new Error('Test error message'),
      };

      const serialized = serializeEvent(event);
      expect((serialized as any).error).toBe('Test error message');

      const deserialized = deserializeEvent(serialized);
      expect(deserialized.type).toBe('ERROR');
      expect((deserialized as any).error.message).toBe('Test error message');
    });

    it('passes through simple events unchanged', () => {
      const events: MergeEvent[] = [
        { type: 'ACQUIRE_LOCK', editorContent: 'test content' },
        { type: 'RELEASE_LOCK' },
        { type: 'UNLOAD' },
        { type: 'PROVIDER_SYNCED' },
      ];

      for (const event of events) {
        const serialized = serializeEvent(event);
        const deserialized = deserializeEvent(serialized);
        expect(deserialized).toEqual(event);
      }
    });
  });

  describe('Effect Serialization', () => {
    it('serializes and deserializes SYNC_TO_REMOTE effect', () => {
      const effect: MergeEffect = {
        type: 'SYNC_TO_REMOTE',
        update: new Uint8Array([10, 20, 30]),
      };

      const serialized = serializeEffect(effect);
      expect(typeof (serialized as any).update).toBe('string');

      const deserialized = deserializeEffect(serialized);
      expect(deserialized.type).toBe('SYNC_TO_REMOTE');
      expect((deserialized as any).update).toEqual(effect.update);
    });

    it('serializes and deserializes DISPATCH_CM6 effect', () => {
      const effect: MergeEffect = {
        type: 'DISPATCH_CM6',
        changes: [{ from: 0, to: 0, insert: 'test' }],
      };

      const serialized = serializeEffect(effect);
      const deserialized = deserializeEffect(serialized);

      expect(deserialized).toEqual(effect);
    });
  });

  describe('Log-Based Replay', () => {
    it('replays log entries successfully', async () => {
      // Record entries using the bridge onEntry callback
      const collected: HSMLogEntry[] = [];
      const t1 = await createTestHSM();
      await loadAndActivate(t1, 'hello');

      // Manually build a log entry for CM6_CHANGE
      const event = cm6Insert(5, ' world', 'hello world');
      const statePathBefore = t1.hsm.state.statePath;

      const capturedEffects: MergeEffect[] = [];
      const unsub = t1.hsm.subscribe((e) => capturedEffects.push(e));
      t1.hsm.send(event);
      unsub();

      const entry: HSMLogEntry = {
        ns: 'mergeHSM',
        ts: new Date().toISOString(),
        guid: 'test-guid',
        path: 'test.md',
        seq: 0,
        event: serializeEvent(event),
        from: statePathBefore,
        to: t1.hsm.state.statePath,
        effects: capturedEffects.map(serializeEffect),
      };
      collected.push(entry);

      // Replay on a fresh HSM
      const t2 = await createTestHSM();
      await loadAndActivate(t2, 'hello');

      const result = replayLogEntries(t2.hsm, collected);

      expect(result.success).toBe(true);
      expect(result.eventsReplayed).toBe(1);
      expect(result.divergences.length).toBe(0);
      expect(result.finalStatePath).toBe('active.tracking');
    });

    it('detects state divergence in log entries', async () => {
      const entries: HSMLogEntry[] = [
        {
          ns: 'mergeHSM',
          ts: new Date().toISOString(),
          guid: 'test-guid',
          path: 'test.md',
          seq: 0,
          event: { type: 'ACQUIRE_LOCK', editorContent: '' },
          from: 'active.tracking',
          to: 'idle.synced', // Wrong - ACQUIRE_LOCK shouldn't cause this
          effects: [],
        },
      ];

      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      const result = replayLogEntries(t.hsm, entries);

      expect(result.success).toBe(false);
      expect(result.divergences.some(d => d.type === 'state-mismatch')).toBe(true);
    });

    it('stops on first divergence when configured', async () => {
      const entries: HSMLogEntry[] = [
        {
          ns: 'mergeHSM',
          ts: new Date().toISOString(),
          guid: 'test-guid',
          path: 'test.md',
          seq: 0,
          event: { type: 'ACQUIRE_LOCK', editorContent: '' },
          from: 'active.tracking',
          to: 'wrong-state',
          effects: [],
        },
        {
          ns: 'mergeHSM',
          ts: new Date().toISOString(),
          guid: 'test-guid',
          path: 'test.md',
          seq: 1,
          event: { type: 'RELEASE_LOCK' },
          from: 'wrong-state',
          to: 'idle.synced',
          effects: [],
        },
      ];

      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      const result = replayLogEntries(t.hsm, entries, { stopOnDivergence: true });

      expect(result.eventsReplayed).toBe(1);
    });

    it('calls onEventReplayed callback', async () => {
      const t1 = await createTestHSM();
      await loadAndActivate(t1, 'hello');

      const event = cm6Insert(5, ' world', 'hello world');
      const statePathBefore = t1.hsm.state.statePath;

      const capturedEffects: MergeEffect[] = [];
      const unsub = t1.hsm.subscribe((e) => capturedEffects.push(e));
      t1.hsm.send(event);
      unsub();

      const entries: HSMLogEntry[] = [{
        ns: 'mergeHSM',
        ts: new Date().toISOString(),
        guid: 'test-guid',
        path: 'test.md',
        seq: 0,
        event: serializeEvent(event),
        from: statePathBefore,
        to: t1.hsm.state.statePath,
        effects: capturedEffects.map(serializeEffect),
      }];

      const t2 = await createTestHSM();
      await loadAndActivate(t2, 'hello');

      const replayedEvents: string[] = [];
      replayLogEntries(t2.hsm, entries, {
        onEventReplayed: (entry) => {
          replayedEvents.push(entry.event.type);
        },
      });

      expect(replayedEvents).toEqual(['CM6_CHANGE']);
    });
  });

  describe('Log Entry Helpers', () => {
    const makeEntry = (seq: number, eventType: string, to: string): HSMLogEntry => ({
      ns: 'mergeHSM',
      ts: new Date().toISOString(),
      guid: 'test-guid',
      path: 'test.md',
      seq,
      event: { type: eventType } as any,
      from: 'idle',
      to,
      effects: [],
    });

    it('filterLogEntries filters by event type', () => {
      const entries = [
        makeEntry(0, 'DISK_CHANGED', 'idle'),
        makeEntry(1, 'CM6_CHANGE', 'active'),
        makeEntry(2, 'DISK_CHANGED', 'idle'),
      ];

      const filtered = filterLogEntries(entries, ['DISK_CHANGED']);
      expect(filtered.length).toBe(2);
      expect(filtered.every(e => e.event.type === 'DISK_CHANGED')).toBe(true);
    });

    it('sliceLogEntries slices by seq range', () => {
      const entries = [
        makeEntry(0, 'A', 'a'),
        makeEntry(1, 'B', 'b'),
        makeEntry(2, 'C', 'c'),
        makeEntry(3, 'D', 'd'),
      ];

      const sliced = sliceLogEntries(entries, 1, 3);
      expect(sliced.length).toBe(2);
      expect(sliced[0].seq).toBe(1);
      expect(sliced[1].seq).toBe(2);
    });

    it('findLogTransition finds target state', () => {
      const entries = [
        makeEntry(0, 'A', 'idle'),
        makeEntry(1, 'B', 'active.tracking'),
        makeEntry(2, 'C', 'idle'),
      ];

      const seq = findLogTransition(entries, 'active.tracking');
      expect(seq).toBe(1);
    });

    it('findLogTransition returns null when not found', () => {
      const entries = [
        makeEntry(0, 'A', 'idle'),
      ];

      const seq = findLogTransition(entries, 'nonexistent');
      expect(seq).toBeNull();
    });
  });

  describe('E2ERecordingBridge', () => {
    // Document registry for testing (simulates SharedFolder.files)
    const documents = new Map<string, { hsm: any; path: string }>();

    // Mock MergeManager for testing
    function createMockManager() {
      const syncStatusSubscribers: (() => void)[] = [];

      return {
        isLoaded: (guid: string) => documents.has(guid),
        isActive: (guid: string) => documents.has(guid),
        syncStatus: {
          subscribe: (fn: () => void) => {
            syncStatusSubscribers.push(fn);
            return () => {
              const idx = syncStatusSubscribers.indexOf(fn);
              if (idx >= 0) syncStatusSubscribers.splice(idx, 1);
            };
          },
        },
        _addHSM: (guid: string, hsm: any) => {
          documents.set(guid, { hsm, path: `${guid}.md` });
          syncStatusSubscribers.forEach(fn => fn());
        },
      };
    }

    function createBridgeConfig() {
      return {
        getHSM: (guid: string) => documents.get(guid)?.hsm,
        getFullPath: (guid: string) => documents.get(guid)?.path,
        getAllGuids: () => Array.from(documents.keys()),
      };
    }

    beforeEach(() => {
      documents.clear();
    });

    it('installs and uninstalls global API', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager, createBridgeConfig());

      expect((globalThis as any).__hsmRecording).toBeUndefined();

      bridge.install();
      expect((globalThis as any).__hsmRecording).toBeDefined();
      expect(typeof (globalThis as any).__hsmRecording.startRecording).toBe('function');
      expect(typeof (globalThis as any).__hsmRecording.stopRecording).toBe('function');
      expect(typeof (globalThis as any).__hsmRecording.getState).toBe('function');

      bridge.uninstall();
      expect((globalThis as any).__hsmRecording).toBeUndefined();
    });

    it('tracks recording state', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager, createBridgeConfig());

      expect(bridge.isRecording()).toBe(false);
      expect(bridge.getState().recording).toBe(false);

      bridge.startRecording('test-session');

      expect(bridge.isRecording()).toBe(true);
      expect(bridge.getState().recording).toBe(true);
      expect(bridge.getState().name).toBe('test-session');
      expect(bridge.getState().id).toBeTruthy();

      bridge.stopRecording();

      expect(bridge.isRecording()).toBe(false);
    });

    it('throws when starting while already recording', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager, createBridgeConfig());

      bridge.startRecording();

      expect(() => bridge.startRecording()).toThrow('Recording already in progress');

      bridge.stopRecording();
    });

    it('throws when stopping without recording', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager, createBridgeConfig());

      expect(() => bridge.stopRecording()).toThrow('No recording in progress');
    });

    it('returns v2 summary JSON when stopping', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager, createBridgeConfig());

      bridge.startRecording('json-test');
      const json = bridge.stopRecording();

      const parsed = JSON.parse(json);
      expect(parsed.version).toBe(2);
      expect(typeof parsed.id).toBe('string');
      expect(typeof parsed.name).toBe('string');
      expect(Array.isArray(parsed.documents)).toBe(true);
    });

    it('streams enriched HSMLogEntry via onEntry callback', async () => {
      const collected: HSMLogEntry[] = [];
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager, {
        ...createBridgeConfig(),
        onEntry: (entry) => collected.push(entry),
      });

      const t = await createTestHSM({ guid: 'test-doc', path: 'test-doc.md' });
      await loadAndActivate(t, 'hello', { guid: 'test-doc', path: 'test-doc.md' });
      mockManager._addHSM('test-doc', t.hsm);

      t.send(cm6Insert(5, ' world', 'hello world'));

      expect(collected.length).toBe(1);
      expect(collected[0].ns).toBe('mergeHSM');
      expect(collected[0].event.type).toBe('CM6_CHANGE');
      expect(collected[0].from).toBeDefined();
      expect(collected[0].to).toBeDefined();
      expect(Array.isArray(collected[0].effects)).toBe(true);

      bridge.dispose();
    });

    it('cleans up properly on dispose', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager, createBridgeConfig());

      bridge.install();
      bridge.startRecording();

      expect(bridge.isRecording()).toBe(true);

      bridge.dispose();

      expect(bridge.isRecording()).toBe(false);
      expect((globalThis as any).__hsmRecording).toBeUndefined();
    });

    it('getActiveDocuments returns loaded document GUIDs', async () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager, createBridgeConfig());

      const t1 = await createTestHSM({ guid: 'doc1' });
      await loadToIdle(t1, { guid: 'doc1' });
      const t2 = await createTestHSM({ guid: 'doc2' });
      await loadToIdle(t2, { guid: 'doc2' });
      mockManager._addHSM('doc1', t1.hsm);
      mockManager._addHSM('doc2', t2.hsm);

      bridge.startRecording();

      const docs = bridge.getActiveDocuments();
      expect(docs).toContain('doc1');
      expect(docs).toContain('doc2');

      bridge.stopRecording();
    });
  });
});
