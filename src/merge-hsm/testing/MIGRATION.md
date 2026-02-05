# forTesting Migration - COMPLETED

All tests have been migrated from `forTesting()` pattern to use real state transition helpers.

## Summary

The `forTesting()` factory has been **removed** from MergeHSM. All tests now use:
- State transition helpers (`loadAndActivate`, `loadToIdle`, `loadToConflict`, etc.)
- Event factories (`DISK_CHANGED`, `cm6Insert`, etc.) to set up test state
- The normal MergeHSM constructor

## Available Helpers

| Helper | Target State |
|--------|--------------|
| `loadAndActivate(hsm, content, opts?)` | `active.tracking` |
| `loadToIdle(hsm, opts?)` | `idle.synced` |
| `loadToLoading(hsm, opts?)` | `loading` |
| `loadToConflict(hsm, opts)` | `active.conflict.bannerShown` |
| `loadToResolving(hsm, opts)` | `active.conflict.resolving` |

## Migration Patterns

### Setting up active mode with content
```typescript
const t = await createTestHSM();
await loadAndActivate(t, 'hello world');
```

### Setting up idle mode with content
```typescript
const t = await createTestHSM();
await loadToIdle(t, { content: 'hello', mtime: 1000 });
```

### Setting up disk state
```typescript
const t = await createTestHSM();
await loadToIdle(t, { content: 'hello', mtime: 1000 });
t.send(await diskChanged('hello', 1000)); // disk matches LCA
```

### Setting up diverged local state
```typescript
const t = await createTestHSM();
await loadAndActivate(t, 'hello', { mtime: 1000 });
t.send(cm6Insert(5, ' world', 'hello world')); // local diverges from LCA
```

### Setting up conflict state
```typescript
const t = await createTestHSM();
await loadToConflict(t, {
  base: 'original',
  remote: 'remote changed',
  disk: 'disk changed',
});
```

## Key Learnings

1. **Real transitions are better** - Tests now validate actual behavior, not bypass it
2. **DISK_CHANGED can be sent during loading** - Added handler to loading state for this
3. **Use state history for transient states** - Check `t.stateHistory` to verify transitions
4. **Accept idle sub-state variations** - After release, may be in any idle sub-state
5. **cm6Insert/cm6Change set up local edits** - Create diverged state for testing
6. **awaitIdleAutoMerge() for async operations** - Wait for idle mode auto-merge to complete

## Changes Made

1. **Removed `forTesting()` method** from MergeHSM.ts
2. **Removed `TestMergeHSMConfig`** interface and export
3. **Updated `createTestHSM()`** to use normal MergeHSM constructor
4. **Added DISK_CHANGED handling to loading state** - Allows disk metadata during loading
5. **Migrated all 94 tests** to use real transitions
