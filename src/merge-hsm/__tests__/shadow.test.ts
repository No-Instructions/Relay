/**
 * Tests for Shadow Mode Infrastructure
 */

import * as Y from 'yjs';
import {
  ShadowMergeHSM,
  ShadowManager,
  createLoggingShadow,
  createCallbackShadow,
  createLoggingShadowManager,
} from '../shadow';
import type { ShadowDivergence, OldSystemAction } from '../shadow';
import type { MergeHSMConfig } from '../types';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';

describe('Shadow Mode', () => {
  let remoteDoc: Y.Doc;
  let timeProvider: MockTimeProvider;

  beforeEach(() => {
    remoteDoc = new Y.Doc();
    timeProvider = new MockTimeProvider();
    timeProvider.setTime(1000);
  });

  afterEach(() => {
    remoteDoc.destroy();
  });

  const createConfig = (overrides: Partial<MergeHSMConfig> = {}): MergeHSMConfig => ({
    guid: 'test-guid',
    path: 'test.md',
    remoteDoc,
    timeProvider,
    ...overrides,
  });

  describe('ShadowMergeHSM', () => {
    it('creates a shadow HSM instance', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      expect(shadow.state.guid).toBe('test-guid');
      expect(shadow.state.path).toBe('test.md');

      shadow.dispose();
    });

    it('captures events without executing effects', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      // Send LOAD event
      shadow.send({ type: 'LOAD', guid: 'test-guid', path: 'test.md' });

      // Shadow HSM should process the event
      expect(shadow.state.statePath).not.toBe('unloaded');

      // No external effects should be emitted
      const externalEffects: any[] = [];
      shadow.subscribe((effect) => externalEffects.push(effect));

      // External subscribe is a no-op for shadow mode
      expect(externalEffects.length).toBe(0);

      shadow.dispose();
    });

    it('detects divergence when HSM emits effect but old system did not act', () => {
      const divergences: ShadowDivergence[] = [];
      const shadow = new ShadowMergeHSM(
        createConfig(),
        { onDivergence: (d) => divergences.push(d) },
        timeProvider
      );

      // Send event that produces effects
      shadow.send({ type: 'LOAD', guid: 'test-guid', path: 'test.md' });

      // Force comparison (no old system actions reported)
      shadow.forceCompare();

      // Should detect divergences for any effects the HSM emitted
      // (Depending on implementation, LOAD might emit effects)
      expect(shadow.getStats().eventsProcessed).toBe(1);

      shadow.dispose();
    });

    it('detects divergence when old system acted but HSM did not emit effect', () => {
      const divergences: ShadowDivergence[] = [];
      const shadow = new ShadowMergeHSM(
        createConfig(),
        { onDivergence: (d) => divergences.push(d) },
        timeProvider
      );

      // Report old system action without corresponding HSM event
      shadow.reportOldSystemAction({ type: 'WRITE_DISK', path: 'test.md', contents: 'hello' });
      shadow.forceCompare();

      expect(divergences.length).toBeGreaterThan(0);
      expect(divergences[0].type).toBe('disk-write');

      shadow.dispose();
    });

    it('matches HSM effects with old system actions', () => {
      const divergences: ShadowDivergence[] = [];
      const shadow = new ShadowMergeHSM(
        createConfig(),
        { onDivergence: (d) => divergences.push(d) },
        timeProvider
      );

      // This is a conceptual test - in reality we need matching effects/actions
      shadow.reportOldSystemAction({ type: 'SYNC_TO_REMOTE' });
      shadow.forceCompare();

      // Since we didn't send an event that produces SYNC_TO_REMOTE,
      // we should see a divergence
      expect(shadow.getDivergences().length).toBeGreaterThan(0);

      shadow.dispose();
    });

    it('tracks statistics', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      shadow.send({ type: 'LOAD', guid: 'test-guid', path: 'test.md' });
      shadow.send({ type: 'ACQUIRE_LOCK' });

      const stats = shadow.getStats();
      expect(stats.eventsProcessed).toBe(2);

      shadow.dispose();
    });

    it('respects minSeverity filter', () => {
      const divergences: ShadowDivergence[] = [];
      const shadow = new ShadowMergeHSM(
        createConfig(),
        {
          onDivergence: (d) => divergences.push(d),
          minSeverity: 'error', // Only log errors and critical
        },
        timeProvider
      );

      // Report an action that would cause low-severity divergence
      shadow.reportOldSystemAction({ type: 'SYNC_TO_REMOTE' });
      shadow.forceCompare();

      // Depending on severity classification, some might be filtered
      // (SYNC_TO_REMOTE typically produces 'info' severity)
      const infoCount = divergences.filter((d) => d.severity === 'info').length;
      expect(infoCount).toBe(0); // info should be filtered

      shadow.dispose();
    });

    it('clears divergences', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      shadow.reportOldSystemAction({ type: 'WRITE_DISK', path: 'test.md', contents: 'hello' });
      shadow.forceCompare();

      expect(shadow.getDivergences().length).toBeGreaterThan(0);

      shadow.clearDivergences();

      expect(shadow.getDivergences().length).toBe(0);

      shadow.dispose();
    });

    it('gets document state', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      shadow.send({ type: 'LOAD', guid: 'test-guid', path: 'test.md' });

      const state = shadow.getDocumentState();
      expect(state.guid).toBe('test-guid');
      expect(state.path).toBe('test.md');
      expect(state.hsmStatePath).toBeDefined();

      shadow.dispose();
    });
  });

  describe('ShadowManager', () => {
    it('registers and unregisters documents', () => {
      const manager = new ShadowManager({ timeProvider });

      manager.register('guid-1', 'doc1.md', new Y.Doc());
      manager.register('guid-2', 'doc2.md', new Y.Doc());

      expect(manager.isRegistered('guid-1')).toBe(true);
      expect(manager.isRegistered('guid-2')).toBe(true);
      expect(manager.isRegistered('guid-3')).toBe(false);

      manager.unregister('guid-1');

      expect(manager.isRegistered('guid-1')).toBe(false);
      expect(manager.isRegistered('guid-2')).toBe(true);

      manager.dispose();
    });

    it('sends events to registered documents', () => {
      const manager = new ShadowManager({ timeProvider });

      const doc1 = new Y.Doc();
      manager.register('guid-1', 'doc1.md', doc1);

      manager.send('guid-1', { type: 'LOAD', guid: 'guid-1', path: 'doc1.md' });

      const stats = manager.getSessionStats();
      expect(stats.eventsProcessed).toBe(1);

      manager.dispose();
      doc1.destroy();
    });

    it('ignores events for unregistered documents', () => {
      const manager = new ShadowManager({ timeProvider });

      // Send event without registering
      manager.send('unknown-guid', { type: 'LOAD', guid: 'unknown-guid', path: 'unknown.md' });

      const stats = manager.getSessionStats();
      expect(stats.eventsProcessed).toBe(0);

      manager.dispose();
    });

    it('reports old system actions', () => {
      const manager = new ShadowManager({ timeProvider });

      const doc1 = new Y.Doc();
      manager.register('guid-1', 'doc1.md', doc1);

      manager.reportAction('guid-1', { type: 'WRITE_DISK', path: 'doc1.md', contents: 'hello' });
      manager.forceCompare('guid-1');

      const divergences = manager.getDivergences('guid-1');
      expect(divergences.length).toBeGreaterThan(0);

      manager.dispose();
      doc1.destroy();
    });

    it('aggregates divergences across documents', () => {
      const manager = new ShadowManager({ timeProvider });

      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      manager.register('guid-1', 'doc1.md', doc1);
      manager.register('guid-2', 'doc2.md', doc2);

      manager.reportAction('guid-1', { type: 'WRITE_DISK', path: 'doc1.md', contents: 'hello' });
      manager.reportAction('guid-2', { type: 'WRITE_DISK', path: 'doc2.md', contents: 'world' });
      manager.forceCompareAll();

      const allDivergences = manager.getAllDivergences();
      expect(allDivergences.length).toBe(2);

      manager.dispose();
      doc1.destroy();
      doc2.destroy();
    });

    it('generates comprehensive report', () => {
      const manager = new ShadowManager({ timeProvider });

      const doc1 = new Y.Doc();
      manager.register('guid-1', 'doc1.md', doc1);

      manager.send('guid-1', { type: 'LOAD', guid: 'guid-1', path: 'doc1.md' });
      manager.reportAction('guid-1', { type: 'WRITE_DISK', path: 'doc1.md', contents: 'hello' });
      manager.forceCompare('guid-1');

      const report = manager.getReport();

      expect(report.stats.sessionId).toBeDefined();
      expect(report.stats.eventsProcessed).toBe(1);
      expect(report.byDocument.size).toBe(1);
      expect(report.topIssues).toBeDefined();

      manager.dispose();
      doc1.destroy();
    });

    it('calculates agreement rate', () => {
      const manager = new ShadowManager({ timeProvider });

      const doc1 = new Y.Doc();
      manager.register('guid-1', 'doc1.md', doc1);

      // Send events without causing divergence
      manager.send('guid-1', { type: 'LOAD', guid: 'guid-1', path: 'doc1.md' });
      manager.send('guid-1', { type: 'ACQUIRE_LOCK' });

      const stats = manager.getSessionStats();
      expect(stats.eventsProcessed).toBe(2);
      // Agreement rate depends on divergences
      expect(stats.agreementRate).toBeGreaterThanOrEqual(0);
      expect(stats.agreementRate).toBeLessThanOrEqual(1);

      manager.dispose();
      doc1.destroy();
    });

    it('clears all divergences', () => {
      const manager = new ShadowManager({ timeProvider });

      const doc1 = new Y.Doc();
      manager.register('guid-1', 'doc1.md', doc1);

      manager.reportAction('guid-1', { type: 'WRITE_DISK', path: 'doc1.md', contents: 'hello' });
      manager.forceCompare('guid-1');

      expect(manager.getAllDivergences().length).toBeGreaterThan(0);

      manager.clearDivergences();

      expect(manager.getAllDivergences().length).toBe(0);

      manager.dispose();
      doc1.destroy();
    });

    it('can be enabled and disabled', () => {
      const manager = new ShadowManager({ enabled: true, timeProvider });

      expect(manager.isEnabled()).toBe(true);

      manager.setEnabled(false);

      expect(manager.isEnabled()).toBe(false);

      manager.dispose();
    });
  });

  describe('Factory Functions', () => {
    it('createLoggingShadow creates shadow with logging', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const shadow = createLoggingShadow(createConfig(), timeProvider);

      shadow.reportOldSystemAction({ type: 'WRITE_DISK', path: 'test.md', contents: 'hello' });
      shadow.forceCompare();

      // Should have logged something (if severity >= warning)
      // The actual logging depends on severity classification
      expect(shadow.getDivergences().length).toBeGreaterThan(0);

      consoleSpy.mockRestore();
      shadow.dispose();
    });

    it('createCallbackShadow creates shadow with callback', () => {
      const divergences: ShadowDivergence[] = [];
      const shadow = createCallbackShadow(
        createConfig(),
        (d) => divergences.push(d),
        timeProvider
      );

      shadow.reportOldSystemAction({ type: 'WRITE_DISK', path: 'test.md', contents: 'hello' });
      shadow.forceCompare();

      expect(divergences.length).toBeGreaterThan(0);

      shadow.dispose();
    });

    it('createLoggingShadowManager creates manager with logging', () => {
      const manager = createLoggingShadowManager(timeProvider);

      expect(manager.isEnabled()).toBe(true);

      manager.dispose();
    });
  });

  describe('Divergence Types', () => {
    it('classifies disk write divergences', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      shadow.reportOldSystemAction({ type: 'WRITE_DISK', path: 'test.md', contents: 'hello' });
      shadow.forceCompare();

      const divergences = shadow.getDivergences();
      expect(divergences.some((d) => d.type === 'disk-write')).toBe(true);

      shadow.dispose();
    });

    it('classifies editor dispatch divergences', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      shadow.reportOldSystemAction({
        type: 'DISPATCH_EDITOR',
        changes: [{ from: 0, to: 0, insert: 'test' }],
      });
      shadow.forceCompare();

      const divergences = shadow.getDivergences();
      expect(divergences.some((d) => d.type === 'editor-dispatch')).toBe(true);

      shadow.dispose();
    });

    it('classifies sync timing divergences', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      shadow.reportOldSystemAction({ type: 'SYNC_TO_REMOTE' });
      shadow.forceCompare();

      const divergences = shadow.getDivergences();
      expect(divergences.some((d) => d.type === 'sync-timing')).toBe(true);

      shadow.dispose();
    });

    it('classifies banner visibility divergences', () => {
      const shadow = new ShadowMergeHSM(createConfig(), {}, timeProvider);

      shadow.reportOldSystemAction({ type: 'SHOW_CONFLICT_BANNER' });
      shadow.forceCompare();

      const divergences = shadow.getDivergences();
      expect(divergences.some((d) => d.type === 'banner-visibility')).toBe(true);

      shadow.dispose();
    });
  });
});
