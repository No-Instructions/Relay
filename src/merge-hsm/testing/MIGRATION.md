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
| `loadAndActivate(hsm, content)` | `active.tracking` | ✅ Ready |
| `loadToIdle(hsm, opts?)` | `idle.clean` | ✅ Ready |
| `loadToAwaitingLCA(hsm, opts?)` | `loading.awaitingLCA` | ✅ Ready |
| `loadToMerging(hsm, ...)` | `active.merging` | ❌ Needed |
| `loadToConflict(hsm, ...)` | `active.conflict.*` | ❌ Needed |

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

### Phase 2: Helpers with lca/disk Support

Most remaining MergeHSM.test.ts tests (32 usages) need `lca` and/or `disk` parameters.

Options:
1. **Extend `loadAndActivate`/`loadToIdle`** to accept `lca` and `disk` options
2. **Add `loadToMerging` helper** for `active.merging` tests (4 usages)
   - Drive to tracking, then trigger merge via REMOTE_UPDATE or DISK_CHANGED
3. **Add `loadToConflict` helper** for conflict state tests (7 usages)
   - `active.conflict.bannerShown` (4 usages)
   - `active.conflict.resolving` (3 usages)

### Phase 3: Edge Cases

- [ ] **Migrate remaining idle states** (3 usages)
  - `idle.diverged` (1)
  - `idle.diskAhead` (1)
  - `idle.remoteAhead` (1)

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
- **Migrated: 48**
  - MergeHSM.test.ts: 14 (simple cases + tests using lca mtime option)
  - invariants.test.ts: 11 (all done)
  - recording.test.ts: 23 (all createTestHSM calls done; 3 remaining are HSMRecording fixtures)
- **Remaining: 23** (MergeHSM.test.ts)
  - With `disk` parameter: ~10 (need disk state setup)
  - `active.merging` state: 4 (need loadToMerging helper)
  - `active.conflict.*` states: 5 (need loadToConflict helper)
  - `idle.diverged/diskAhead`: 2 (edge cases, may stay with forTesting)
  - Lock cycle tests: 2 (internal state vector mismatch, keep with forTesting)

### Key Learnings

1. Add `t.clearEffects()` after `loadAndActivate`/`loadToIdle` when tests count specific effects
2. Some tests for transient states (like `idle.diskAhead`) can't be migrated because real transitions auto-merge - keep those with forTesting
3. Tests with `lca` or `disk` parameters need extended helpers or stay with old pattern for now
4. Lock cycle tests (`acquireLock/releaseLock` sequences) have state vector mismatches when using real transitions vs forTesting - these need to stay with forTesting
5. The `mtime` option in `loadAndActivate`/`loadToIdle` allows migrating tests that only need custom LCA timestamp
