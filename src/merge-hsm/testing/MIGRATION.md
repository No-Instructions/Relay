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

- [ ] **MergeHSM.test.ts `active.tracking`** (35 usages)
  - Use `loadAndActivate(t, content)`

- [ ] **MergeHSM.test.ts `idle.clean`** (16 usages)
  - Use `loadToIdle(t, { content })`

- [ ] **invariants.test.ts `active.tracking`** (11 usages)
  - Use `loadAndActivate(t, content)`

- [ ] **recording.test.ts `active.tracking`** (14 usages)
  - Use `loadAndActivate(t, content)`

- [ ] **recording.test.ts `idle.clean`** (9 usages)
  - Use `loadToIdle(t, { content })`

### Phase 2: New Helpers Needed

- [ ] **Add `loadToMerging` helper** for `active.merging` tests (4 usages)
  - Drive to tracking, then trigger merge via REMOTE_UPDATE or DISK_CHANGED

- [ ] **Add `loadToConflict` helper** for conflict state tests (7 usages)
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

- Total usages: **94**
- Migrated: **0**
- Remaining: **94**
