/**
 * Tests for HSM Recording Infrastructure
 */

import {
  RecordingMergeHSM,
  createE2ERecorder,
  createIntegrationRecorder,
  replayRecording,
  assertReplaySucceeds,
  serializeRecording,
  deserializeRecording,
  serializeEvent,
  deserializeEvent,
  serializeEffect,
  deserializeEffect,
  uint8ArrayToBase64,
  base64ToUint8Array,
  E2ERecordingBridge,
} from '../recording';
import type { HSMRecording, ReplayResult } from '../recording';
import { createTestHSM, cm6Insert, diskChanged, acquireLock } from '../testing';
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

  describe('RecordingMergeHSM', () => {
    it('records events and effects', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const recorder = new RecordingMergeHSM(t.hsm, {
        metadata: { source: 'unit-test', testName: 'basic recording' },
      });

      recorder.startRecording('test-recording');

      // Send some events
      recorder.send(cm6Insert(5, ' world', 'hello world'));

      const recording = recorder.stopRecording();

      expect(recording.version).toBe(1);
      expect(recording.name).toBe('test-recording');
      expect(recording.timeline.length).toBe(1);
      expect(recording.timeline[0].event.type).toBe('CM6_CHANGE');
      expect(recording.timeline[0].statePathBefore).toBe('active.tracking');
      expect(recording.timeline[0].statePathAfter).toBe('active.tracking');
      expect(recording.metadata.source).toBe('unit-test');
      expect(recording.metadata.testName).toBe('basic recording');
    });

    it('captures initial state', async () => {
      const t = await createTestHSM({
        initialState: 'idle.clean',
        localDoc: 'initial content',
      });

      const recorder = new RecordingMergeHSM(t.hsm);
      recorder.startRecording();

      const recording = recorder.stopRecording();

      expect(recording.initialState.statePath).toBe('idle.clean');
      expect(recording.initialState.snapshot).toBeDefined();
    });

    it('captures effects emitted during events', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const recorder = new RecordingMergeHSM(t.hsm);
      recorder.startRecording();

      // This should emit SYNC_TO_REMOTE effect
      recorder.send(cm6Insert(5, ' world', 'hello world'));

      const recording = recorder.stopRecording();

      expect(recording.timeline[0].effects.length).toBeGreaterThan(0);
      expect(recording.timeline[0].effects.some(e => e.type === 'SYNC_TO_REMOTE')).toBe(true);
    });

    it('respects maxEntries limit', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const recorder = new RecordingMergeHSM(t.hsm, { maxEntries: 3 });
      recorder.startRecording();

      // Send more events than maxEntries
      for (let i = 0; i < 5; i++) {
        recorder.send(cm6Insert(5 + i, `${i}`, `hello${i}`));
      }

      const recording = recorder.stopRecording();

      expect(recording.timeline.length).toBe(3);
      // Should keep the most recent events
      expect(recording.timeline[0].seq).toBe(2);
    });

    it('respects eventFilter', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const recorder = new RecordingMergeHSM(t.hsm, {
        eventFilter: (event) => event.type !== 'CM6_CHANGE',
      });
      recorder.startRecording();

      recorder.send(cm6Insert(5, ' world', 'hello world'));

      const recording = recorder.stopRecording();

      expect(recording.timeline.length).toBe(0);
    });

    it('throws if already recording', async () => {
      const t = await createTestHSM({ initialState: 'idle.clean' });
      const recorder = new RecordingMergeHSM(t.hsm);

      recorder.startRecording();

      expect(() => recorder.startRecording()).toThrow('Recording already in progress');
    });

    it('throws if not recording when stopping', async () => {
      const t = await createTestHSM({ initialState: 'idle.clean' });
      const recorder = new RecordingMergeHSM(t.hsm);

      expect(() => recorder.stopRecording()).toThrow('No recording in progress');
    });

    it('tracks recording state', async () => {
      const t = await createTestHSM({ initialState: 'idle.clean' });
      const recorder = new RecordingMergeHSM(t.hsm);

      expect(recorder.isRecording()).toBe(false);
      expect(recorder.getRecordingState().recording).toBe(false);

      recorder.startRecording('test');

      expect(recorder.isRecording()).toBe(true);
      expect(recorder.getRecordingState().name).toBe('test');
      expect(recorder.getRecordingState().id).toBeTruthy();

      recorder.stopRecording();

      expect(recorder.isRecording()).toBe(false);
    });
  });

  describe('Recording Serialization', () => {
    it('serializes and deserializes a complete recording', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const recorder = new RecordingMergeHSM(t.hsm);
      recorder.startRecording('serialization-test');

      recorder.send(cm6Insert(5, ' world', 'hello world'));

      const recording = recorder.stopRecording();

      const json = serializeRecording(recording);
      expect(typeof json).toBe('string');

      const parsed = deserializeRecording(json);

      expect(parsed.version).toBe(recording.version);
      expect(parsed.id).toBe(recording.id);
      expect(parsed.name).toBe(recording.name);
      expect(parsed.timeline.length).toBe(recording.timeline.length);
      expect(parsed.initialState.statePath).toBe(recording.initialState.statePath);
    });

    it('throws on unsupported version', () => {
      const json = JSON.stringify({ version: 99, id: 'test' });

      expect(() => deserializeRecording(json)).toThrow('Unsupported recording version: 99');
    });
  });

  describe('Replay', () => {
    it('replays a recording successfully', async () => {
      // Create a recording
      const t1 = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const recorder = new RecordingMergeHSM(t1.hsm);
      recorder.startRecording();
      recorder.send(cm6Insert(5, ' world', 'hello world'));
      const recording = recorder.stopRecording();

      // Replay on a fresh HSM
      const t2 = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const result = replayRecording(t2.hsm, recording);

      expect(result.success).toBe(true);
      expect(result.eventsReplayed).toBe(1);
      expect(result.divergences.length).toBe(0);
      expect(result.finalStatePath).toBe('active.tracking');
    });

    it('detects state divergence', async () => {
      // Create a recording that expects a certain transition
      const recording: HSMRecording = {
        version: 1,
        id: 'test',
        name: 'test',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        document: { guid: 'test-guid', path: 'test.md' },
        initialState: {
          statePath: 'active.tracking',
          snapshot: {
            timestamp: Date.now(),
            state: {
              guid: 'test-guid',
              path: 'test.md',
              statePath: 'active.tracking',
              lca: null,
              disk: null,
              localStateVector: null,
              remoteStateVector: null,
            },
            localDocText: 'hello',
            remoteDocText: null,
          },
        },
        timeline: [
          {
            seq: 0,
            timestamp: Date.now(),
            event: { type: 'ACQUIRE_LOCK', editorContent: '' },
            statePathBefore: 'active.tracking',
            statePathAfter: 'idle.clean', // This is wrong - ACQUIRE_LOCK shouldn't cause this
            effects: [],
          },
        ],
        metadata: { source: 'unit-test' },
      };

      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const result = replayRecording(t.hsm, recording);

      expect(result.success).toBe(false);
      expect(result.divergences.some(d => d.type === 'state-mismatch')).toBe(true);
    });

    it('stops on first divergence when configured', async () => {
      const recording: HSMRecording = {
        version: 1,
        id: 'test',
        name: 'test',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        document: { guid: 'test-guid', path: 'test.md' },
        initialState: {
          statePath: 'active.tracking',
          snapshot: {
            timestamp: Date.now(),
            state: {
              guid: 'test-guid',
              path: 'test.md',
              statePath: 'active.tracking',
              lca: null,
              disk: null,
              localStateVector: null,
              remoteStateVector: null,
            },
            localDocText: 'hello',
            remoteDocText: null,
          },
        },
        timeline: [
          {
            seq: 0,
            timestamp: Date.now(),
            event: { type: 'ACQUIRE_LOCK', editorContent: '' },
            statePathBefore: 'active.tracking',
            statePathAfter: 'wrong-state' as any,
            effects: [],
          },
          {
            seq: 1,
            timestamp: Date.now(),
            event: { type: 'RELEASE_LOCK' },
            statePathBefore: 'wrong-state' as any,
            statePathAfter: 'idle.clean',
            effects: [],
          },
        ],
        metadata: { source: 'unit-test' },
      };

      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const result = replayRecording(t.hsm, recording, { stopOnDivergence: true });

      expect(result.eventsReplayed).toBe(1); // Stopped after first event
    });

    it('calls onEventReplayed callback', async () => {
      const t1 = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const recorder = new RecordingMergeHSM(t1.hsm);
      recorder.startRecording();
      recorder.send(cm6Insert(5, ' world', 'hello world'));
      const recording = recorder.stopRecording();

      const t2 = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const replayedEvents: string[] = [];
      replayRecording(t2.hsm, recording, {
        onEventReplayed: (entry) => {
          replayedEvents.push(entry.event.type);
        },
      });

      expect(replayedEvents).toEqual(['CM6_CHANGE']);
    });
  });

  describe('assertReplaySucceeds', () => {
    it('does not throw on successful replay', async () => {
      const t1 = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const recorder = new RecordingMergeHSM(t1.hsm);
      recorder.startRecording();
      recorder.send(cm6Insert(5, ' world', 'hello world'));
      const recording = recorder.stopRecording();

      const t2 = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      expect(() => assertReplaySucceeds(t2.hsm, recording)).not.toThrow();
    });

    it('throws on divergence with details', async () => {
      const recording: HSMRecording = {
        version: 1,
        id: 'test',
        name: 'test',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        document: { guid: 'test-guid', path: 'test.md' },
        initialState: {
          statePath: 'active.tracking',
          snapshot: {
            timestamp: Date.now(),
            state: {
              guid: 'test-guid',
              path: 'test.md',
              statePath: 'active.tracking',
              lca: null,
              disk: null,
              localStateVector: null,
              remoteStateVector: null,
            },
            localDocText: 'hello',
            remoteDocText: null,
          },
        },
        timeline: [
          {
            seq: 0,
            timestamp: Date.now(),
            event: { type: 'ACQUIRE_LOCK', editorContent: '' },
            statePathBefore: 'active.tracking',
            statePathAfter: 'wrong' as any,
            effects: [],
          },
        ],
        metadata: { source: 'unit-test' },
      };

      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      expect(() => assertReplaySucceeds(t.hsm, recording)).toThrow(/divergence/);
    });
  });

  describe('Factory Functions', () => {
    it('createE2ERecorder sets correct metadata', async () => {
      const t = await createTestHSM({ initialState: 'idle.clean' });
      const recorder = createE2ERecorder(t.hsm, 'my-test', '/path/to/test.ts');

      recorder.startRecording();
      const recording = recorder.stopRecording();

      expect(recording.metadata.source).toBe('e2e-test');
      expect(recording.metadata.testName).toBe('my-test');
      expect(recording.metadata.testFile).toBe('/path/to/test.ts');
    });

    it('createIntegrationRecorder sets correct metadata', async () => {
      const t = await createTestHSM({ initialState: 'idle.clean' });
      const recorder = createIntegrationRecorder(t.hsm, 'integration-test-name');

      recorder.startRecording();
      const recording = recorder.stopRecording();

      expect(recording.metadata.source).toBe('integration-test');
      expect(recording.metadata.testName).toBe('integration-test-name');
    });
  });

  describe('E2ERecordingBridge', () => {
    // Mock MergeManager for testing
    function createMockManager() {
      const registeredGuids: string[] = [];
      const hsms = new Map(); // Named 'hsms' to match real MergeManager
      const syncStatusSubscribers: (() => void)[] = [];

      return {
        getRegisteredGuids: () => registeredGuids,
        isLoaded: (guid: string) => hsms.has(guid),
        getPath: (guid: string) => `${guid}.md`,
        hsms, // Exposed as 'hsms' for E2ERecordingBridge.getHSMForGuid
        syncStatus: {
          subscribe: (fn: () => void) => {
            syncStatusSubscribers.push(fn);
            return () => {
              const idx = syncStatusSubscribers.indexOf(fn);
              if (idx >= 0) syncStatusSubscribers.splice(idx, 1);
            };
          },
        },
        // Helper to add a loaded HSM for testing
        _addHSM: (guid: string, hsm: any) => {
          registeredGuids.push(guid);
          hsms.set(guid, hsm);
          syncStatusSubscribers.forEach(fn => fn());
        },
      };
    }

    it('installs and uninstalls global API', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager);

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
      const bridge = new E2ERecordingBridge(mockManager);

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
      const bridge = new E2ERecordingBridge(mockManager);

      bridge.startRecording();

      expect(() => bridge.startRecording()).toThrow('Recording already in progress');

      bridge.stopRecording();
    });

    it('throws when stopping without recording', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager);

      expect(() => bridge.stopRecording()).toThrow('No recording in progress');
    });

    it('returns valid JSON when stopping', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager);

      bridge.startRecording('json-test');
      const json = bridge.stopRecording();

      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('records HSM events when loaded', async () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager);

      // Create a test HSM and add it to the manager
      const t = await createTestHSM({
        guid: 'test-doc',
        path: 'test-doc.md',
        initialState: 'active.tracking',
        localDoc: 'hello',
      });
      mockManager._addHSM('test-doc', t.hsm);

      bridge.startRecording('event-capture-test');

      // Send an event to the HSM
      t.send(cm6Insert(5, ' world', 'hello world'));

      const json = bridge.stopRecording();
      const recordings = JSON.parse(json);

      expect(recordings.length).toBe(1);
      expect(recordings[0].document.guid).toBe('test-doc');
      expect(recordings[0].timeline.length).toBe(1);
      expect(recordings[0].timeline[0].event.type).toBe('CM6_CHANGE');
    });

    it('cleans up properly on dispose', () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager);

      bridge.install();
      bridge.startRecording();

      expect(bridge.isRecording()).toBe(true);

      bridge.dispose();

      expect(bridge.isRecording()).toBe(false);
      expect((globalThis as any).__hsmRecording).toBeUndefined();
    });

    it('getActiveDocuments returns loaded document GUIDs', async () => {
      const mockManager = createMockManager() as any;
      const bridge = new E2ERecordingBridge(mockManager);

      // Add some HSMs
      const t1 = await createTestHSM({ guid: 'doc1', initialState: 'idle.clean' });
      const t2 = await createTestHSM({ guid: 'doc2', initialState: 'idle.clean' });
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
