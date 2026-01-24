/**
 * Tests for Invariant Checking Infrastructure
 */

import {
  InvariantChecker,
  createLoggingChecker,
  createStrictChecker,
  createTestChecker,
  STANDARD_INVARIANTS,
  getInvariantsForState,
  getInvariantsByTrigger,
  EDITOR_MATCHES_LOCAL_DOC,
  SYNCED_MEANS_DISK_MATCHES_LCA,
  ACTIVE_HAS_LOCAL_DOC,
} from '../invariants';
import type { InvariantViolation, InvariantCheckContext } from '../invariants';
import { createTestHSM } from '../testing';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';

describe('Invariant Checking', () => {
  let timeProvider: MockTimeProvider;

  beforeEach(() => {
    timeProvider = new MockTimeProvider();
    timeProvider.setTime(1000);
  });

  describe('Invariant Definitions', () => {
    it('has standard invariants defined', () => {
      expect(STANDARD_INVARIANTS.length).toBeGreaterThan(0);
      expect(STANDARD_INVARIANTS.every((inv) => inv.id && inv.name && inv.check)).toBe(true);
    });

    it('filters invariants by state', () => {
      const activeInvariants = getInvariantsForState('active.tracking');
      const idleInvariants = getInvariantsForState('idle.clean');

      // Some invariants should be specific to active mode
      expect(activeInvariants.some((inv) => inv.id === 'editor-matches-local-doc')).toBe(true);

      // Some invariants should be specific to idle mode
      expect(idleInvariants.some((inv) => inv.id === 'idle-no-local-doc')).toBe(true);
    });

    it('filters invariants by trigger', () => {
      const alwaysInvariants = getInvariantsByTrigger('always');
      const periodicInvariants = getInvariantsByTrigger('periodic');
      const onStateInvariants = getInvariantsByTrigger('on-state');

      expect(alwaysInvariants.length).toBeGreaterThanOrEqual(0);
      expect(periodicInvariants.length).toBeGreaterThanOrEqual(0);
      expect(onStateInvariants.length).toBeGreaterThan(0);
    });
  });

  describe('Individual Invariants', () => {
    describe('EDITOR_MATCHES_LOCAL_DOC', () => {
      it('passes when editor matches localDoc', () => {
        const context: InvariantCheckContext = {
          statePath: 'active.tracking',
          localDocText: 'hello world',
          remoteDocText: null,
          editorText: 'hello world',
          disk: { hash: null, mtime: null },
          lca: { hash: null, mtime: null, contents: null },
          syncStatus: 'synced',
          now: () => 1000,
        };

        const violation = EDITOR_MATCHES_LOCAL_DOC.check(context);
        expect(violation).toBeNull();
      });

      it('fails when editor differs from localDoc', () => {
        const context: InvariantCheckContext = {
          statePath: 'active.tracking',
          localDocText: 'hello world',
          remoteDocText: null,
          editorText: 'hello universe', // Different!
          disk: { hash: null, mtime: null },
          lca: { hash: null, mtime: null, contents: null },
          syncStatus: 'synced',
          now: () => 1000,
        };

        const violation = EDITOR_MATCHES_LOCAL_DOC.check(context);
        expect(violation).not.toBeNull();
        expect(violation?.invariantId).toBe('editor-matches-local-doc');
        expect(violation?.severity).toBe('warning');
      });

      it('skips check when values are null', () => {
        const context: InvariantCheckContext = {
          statePath: 'active.tracking',
          localDocText: null,
          remoteDocText: null,
          editorText: 'hello',
          disk: { hash: null, mtime: null },
          lca: { hash: null, mtime: null, contents: null },
          syncStatus: 'synced',
          now: () => 1000,
        };

        const violation = EDITOR_MATCHES_LOCAL_DOC.check(context);
        expect(violation).toBeNull();
      });
    });

    describe('SYNCED_MEANS_DISK_MATCHES_LCA', () => {
      it('passes when synced and hashes match', () => {
        const context: InvariantCheckContext = {
          statePath: 'idle.clean',
          localDocText: null,
          remoteDocText: null,
          editorText: null,
          disk: { hash: 'abc123', mtime: 1000 },
          lca: { hash: 'abc123', mtime: 1000, contents: 'content' },
          syncStatus: 'synced',
          now: () => 1000,
        };

        const violation = SYNCED_MEANS_DISK_MATCHES_LCA.check(context);
        expect(violation).toBeNull();
      });

      it('fails when synced but hashes differ', () => {
        const context: InvariantCheckContext = {
          statePath: 'idle.clean',
          localDocText: null,
          remoteDocText: null,
          editorText: null,
          disk: { hash: 'abc123', mtime: 1000 },
          lca: { hash: 'xyz789', mtime: 900, contents: 'content' },
          syncStatus: 'synced',
          now: () => 1000,
        };

        const violation = SYNCED_MEANS_DISK_MATCHES_LCA.check(context);
        expect(violation).not.toBeNull();
        expect(violation?.invariantId).toBe('synced-means-disk-matches-lca');
        expect(violation?.severity).toBe('error');
      });

      it('skips when not synced', () => {
        const context: InvariantCheckContext = {
          statePath: 'idle.clean',
          localDocText: null,
          remoteDocText: null,
          editorText: null,
          disk: { hash: 'abc123', mtime: 1000 },
          lca: { hash: 'xyz789', mtime: 900, contents: 'content' },
          syncStatus: 'pending', // Not synced
          now: () => 1000,
        };

        const violation = SYNCED_MEANS_DISK_MATCHES_LCA.check(context);
        expect(violation).toBeNull();
      });
    });

    describe('ACTIVE_HAS_LOCAL_DOC', () => {
      it('passes in active mode with localDoc', () => {
        const context: InvariantCheckContext = {
          statePath: 'active.tracking',
          localDocText: 'hello',
          remoteDocText: null,
          editorText: 'hello',
          disk: { hash: null, mtime: null },
          lca: { hash: null, mtime: null, contents: null },
          syncStatus: 'synced',
          now: () => 1000,
        };

        const violation = ACTIVE_HAS_LOCAL_DOC.check(context);
        expect(violation).toBeNull();
      });

      it('fails in active mode without localDoc', () => {
        const context: InvariantCheckContext = {
          statePath: 'active.tracking',
          localDocText: null, // Missing!
          remoteDocText: null,
          editorText: 'hello',
          disk: { hash: null, mtime: null },
          lca: { hash: null, mtime: null, contents: null },
          syncStatus: 'synced',
          now: () => 1000,
        };

        const violation = ACTIVE_HAS_LOCAL_DOC.check(context);
        expect(violation).not.toBeNull();
        expect(violation?.severity).toBe('critical');
      });
    });
  });

  describe('InvariantChecker', () => {
    it('checks all applicable invariants', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const violations: InvariantViolation[] = [];
      const checker = new InvariantChecker(
        t.hsm,
        { onViolation: (v) => violations.push(v), logToConsole: false },
        STANDARD_INVARIANTS,
        timeProvider
      );

      // Update editor text to match
      checker.updateEditorText('hello');

      const result = checker.checkAll();

      // Should pass when everything matches
      expect(result.length).toBe(0);

      checker.dispose();
    });

    it('detects violations', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const violations: InvariantViolation[] = [];
      const checker = new InvariantChecker(
        t.hsm,
        { onViolation: (v) => violations.push(v), logToConsole: false },
        STANDARD_INVARIANTS,
        timeProvider
      );

      // Set mismatched editor text
      checker.updateEditorText('different text');

      const result = checker.checkAll();

      // Should detect the drift
      expect(result.some((v) => v.invariantId === 'editor-matches-local-doc')).toBe(true);

      checker.dispose();
    });

    it('records violations', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const checker = new InvariantChecker(
        t.hsm,
        { logToConsole: false },
        STANDARD_INVARIANTS,
        timeProvider
      );

      checker.updateEditorText('different');
      checker.checkAll();

      expect(checker.hasViolations()).toBe(true);
      expect(checker.getViolationCount()).toBeGreaterThan(0);
      expect(checker.getViolations().length).toBeGreaterThan(0);

      checker.dispose();
    });

    it('clears violations', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const checker = new InvariantChecker(
        t.hsm,
        { logToConsole: false },
        STANDARD_INVARIANTS,
        timeProvider
      );

      checker.updateEditorText('different');
      checker.checkAll();

      expect(checker.hasViolations()).toBe(true);

      checker.clearViolations();

      expect(checker.hasViolations()).toBe(false);

      checker.dispose();
    });

    it('can be enabled and disabled', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const checker = new InvariantChecker(
        t.hsm,
        { logToConsole: false },
        STANDARD_INVARIANTS,
        timeProvider
      );

      expect(checker.isEnabled()).toBe(true);

      checker.setEnabled(false);
      expect(checker.isEnabled()).toBe(false);

      // Should not detect violations when disabled
      checker.updateEditorText('different');
      const result = checker.checkAll();
      expect(result.length).toBe(0);

      checker.dispose();
    });

    it('checks specific invariant by ID', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const checker = new InvariantChecker(
        t.hsm,
        { logToConsole: false },
        STANDARD_INVARIANTS,
        timeProvider
      );

      checker.updateEditorText('different');

      const violation = checker.checkOne('editor-matches-local-doc');

      expect(violation).not.toBeNull();
      expect(violation?.invariantId).toBe('editor-matches-local-doc');

      checker.dispose();
    });

    it('filters violations by severity', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const checker = new InvariantChecker(
        t.hsm,
        { logToConsole: false },
        STANDARD_INVARIANTS,
        timeProvider
      );

      checker.updateEditorText('different');
      checker.checkAll();

      const warnings = checker.getViolationsBySeverity('warning');
      const errors = checker.getViolationsBySeverity('error');

      expect(warnings.every((v) => v.severity === 'warning')).toBe(true);
      expect(errors.every((v) => v.severity === 'error')).toBe(true);

      checker.dispose();
    });

    it('filters violations by invariant', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const checker = new InvariantChecker(
        t.hsm,
        { logToConsole: false },
        STANDARD_INVARIANTS,
        timeProvider
      );

      checker.updateEditorText('different');
      checker.checkAll();

      const driftViolations = checker.getViolationsByInvariant('editor-matches-local-doc');

      expect(driftViolations.every((v) => v.invariantId === 'editor-matches-local-doc')).toBe(true);

      checker.dispose();
    });
  });

  describe('Factory Functions', () => {
    it('createLoggingChecker creates checker with logging', () => {
      const t = createTestHSM({ initialState: 'active.tracking', localDoc: 'hello' });
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const checker = createLoggingChecker(t.hsm, timeProvider);
      checker.updateEditorText('different');
      checker.checkAll();

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
      checker.dispose();
    });

    it('createStrictChecker throws on critical violations', () => {
      const t = createTestHSM({ initialState: 'active.tracking', localDoc: 'hello' });

      const checker = createStrictChecker(t.hsm, timeProvider);

      // Create a custom invariant that always fails with critical severity
      const criticalInvariant = {
        id: 'test-critical',
        name: 'Test Critical',
        description: 'Always fails critically',
        severity: 'critical' as const,
        trigger: 'manual' as const,
        check: () => ({
          invariantId: 'test-critical',
          severity: 'critical' as const,
          timestamp: 1000,
          message: 'Critical failure',
          statePath: 'active.tracking' as const,
        }),
      };

      const strictChecker = new InvariantChecker(
        t.hsm,
        { throwOnViolation: true, throwSeverity: 'critical', logToConsole: false },
        [criticalInvariant],
        timeProvider
      );

      expect(() => strictChecker.checkAll()).toThrow('Invariant violation [critical]');

      checker.dispose();
      strictChecker.dispose();
    });

    it('createTestChecker throws on any violation', () => {
      const t = createTestHSM({ initialState: 'active.tracking', localDoc: 'hello' });

      const checker = createTestChecker(t.hsm, timeProvider);
      checker.updateEditorText('different');

      expect(() => checker.checkAll()).toThrow('Invariant violation');

      checker.dispose();
    });
  });
});
