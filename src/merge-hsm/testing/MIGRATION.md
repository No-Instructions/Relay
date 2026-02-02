# forTesting Migration Plan

Migrate tests from `forTesting()` pattern to state transition helpers that drive real HSM transitions.

## Why Migrate?

The `forTesting()` factory bypasses the state machine by directly mutating internal state (`_statePath`, `_lca`, `_disk`). This:
- Creates objects in potentially invalid states
- Couples tests to implementation details
- Doesn't validate transition paths work correctly

The new helpers (`loadAndActivate`, `loadToIdle`, etc.) drive through real events, ensuring tests validate actual behavior.

## Available Helpers

| Helper | Target State | Status |
|--------|--------------|--------|
| `loadAndActivate(hsm, content, opts?)` | `active.tracking` | ✅ Ready |
| `loadToIdle(hsm, opts?)` | `idle.clean` | ✅ Ready |
| `loadToAwaitingLCA(hsm, opts?)` | `loading.awaitingLCA` | ✅ Ready |
| `loadToConflict(hsm, opts)` | `active.conflict.bannerShown` | ✅ Ready |
| `loadToResolving(hsm, opts)` | `active.conflict.resolving` | ✅ Ready |

## Migration Tasks

### Phase 1: Easy Migrations (existing helpers)

- [x] **MergeHSM.test.ts simple cases** (14 migrated) ✅ DONE
  - Migrated tests without `lca`/`disk` params
  - Also migrated tests using `lca` with custom mtime (via `{ mtime }` option)
  - Remaining 23 usages need `disk`, `active.merging`, or `active.conflict.*` states

- [x] **invariants.test.ts `active.tracking`** (11 usages) ✅ DONE
  - All migrated to `loadAndActivate(t, 'hello')`

- [x] **recording.test.ts `active.tracking` + `idle.clean`** (23 migrated) ✅ DONE
  - Remaining 3 are HSMRecording object literals (test fixtures), not createTestHSM calls

### Phase 2: Conflict State Helpers ✅ DONE

- [x] **Added `loadToConflict` helper** - drives to `active.conflict.bannerShown` through real transitions
- [x] **Added `loadToResolving` helper** - drives to `active.conflict.resolving`
- [x] **Migrated all conflict resolution tests** (12 tests migrated)

### Phase 3: Remaining Tests (11 usages)

Tests still using forTesting fall into these categories:

1. **Tests needing `disk` state in idle** (5 tests) - for auto-merge behavior testing
   - Could extend `loadToIdle` to accept disk metadata through `PERSISTENCE_LOADED`

2. **Tests needing `disk` state in active** (3 tests) - BUG-006/007 disk state tests
   - These test SAVE_COMPLETE updating disk state

3. **Transient state tests** (1 test) - `idle.diskAhead`
   - Real transitions auto-merge immediately, can't pause in transient state

4. **Lock cycle test** (1 test) - state vector mismatch
   - May indicate a real bug in how state vectors are managed

5. **Diverged active state** (1 test) - localDoc differs from LCA
   - Could migrate by making edits after `loadAndActivate`

### Phase 4: Cleanup

- [ ] **Remove `forTesting()` method** from MergeHSM.ts
- [ ] **Remove `TestMergeHSMConfig`** type export from index.ts
- [ ] **Update `createTestHSM`** to not use forTesting internally

## Migration Pattern

### Before (forTesting pattern)
```typescript
const t = await createTestHSM({
  initialState: 'active.tracking',
  localDoc: 'hello world',
});
```

### After (real transitions)
```typescript
const t = await createTestHSM();
await loadAndActivate(t, 'hello world');
```

## Progress

- Total usages at start: **94**
- **Migrated: 60**
  - MergeHSM.test.ts: 26 (simple cases, mtime option, and conflict states)
  - invariants.test.ts: 11 (all done)
  - recording.test.ts: 23 (all createTestHSM calls done; 3 remaining are HSMRecording fixtures)
- **Remaining: 11** (MergeHSM.test.ts)
  - With `disk` parameter + `active.tracking`: 3 (need disk in active mode)
  - With `disk` parameter + `idle.clean`: 5 (need disk in idle mode for auto-merge tests)
  - `idle.diskAhead`: 1 (transient state, may stay with forTesting)
  - Lock cycle test: 1 (internal state vector mismatch)
  - Diverged local/LCA in active: 1 (needs local edit after activation)

### Key Learnings

1. Add `t.clearEffects()` after `loadAndActivate`/`loadToIdle` when tests count specific effects
2. **Conflicts can be driven through real transitions!** Use `loadToConflict` which:
   - Loads to idle with base content
   - Receives remote update with different content
   - Receives disk change with yet another content
   - Acquires lock from diverged state → triggers real conflict
3. Some tests for transient states (like `idle.diskAhead`) can't be migrated because real transitions auto-merge - keep those with forTesting
4. Lock cycle tests (`acquireLock/releaseLock` sequences) have state vector mismatches - investigating if this is a bug
5. The `mtime` option in `loadAndActivate`/`loadToIdle` allows migrating tests that only need custom LCA timestamp
