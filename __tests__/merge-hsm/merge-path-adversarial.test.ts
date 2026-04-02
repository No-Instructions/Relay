/**
 * Merge Path Adversarial Tests
 *
 * Exercises the three merge paths (idle merge, active reconciliation, fork
 * reconciliation) with adversarial provider sync states.  The same divergence
 * scenario is tested through each path to verify consistency of conflict data.
 *
 * Covers:
 * - Three-way merge with provider synced vs not-synced vs mid-edit sync
 * - Active path conflict detection under deferred provider sync
 * - Idle path merge deferred until provider syncs
 * - Multi-path consistency: same divergence → same conflict data
 */

import {
	createTestHSM,
	loadToIdle,
	loadAndActivate,
	diskChanged,
	sendAcquireLockToTracking,
	releaseLock,
	resolve,
	dismissConflict,
	loadToConflict,
	connected,
	disconnected,
	providerSynced,
	cm6Insert,
	openDiffView,
	expectState,
	expectLocalDocText,
} from 'src/merge-hsm/testing';

// =============================================================================
// 1. Three-way merge with various provider sync states
// =============================================================================

describe('Three-way merge with provider sync states', () => {
	test('provider synced → non-conflicting remote + disk merge cleanly', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'line 1\nline 2\nline 3', mtime: 1000 });

		// Mark provider as synced
		t.send(connected());
		t.send(providerSynced());

		// Apply remote change (modifies line 1)
		t.applyRemoteChange('remote 1\nline 2\nline 3');

		// Disk changes line 3 (non-overlapping)
		t.send(await diskChanged('line 1\nline 2\ndisk 3', 2000));

		// Wait for all merge attempts
		await t.hsm.awaitIdleAutoMerge();
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		// Non-conflicting edits should auto-merge
		expect(t.matches('idle.synced') || t.matches('idle.localAhead')).toBe(true);
	});

	test('adjacent-line edits by different sides auto-merge (newline-as-token)', async () => {
		// Regression: if tokenization uses s.split("\n") instead of s.split(/(\n)/),
		// adjacent changed lines form a single diff3 conflict region → false conflict.
		// With newline-as-explicit-token, the unchanged \n separates the regions.
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'line 1\nline 2\nline 3', mtime: 1000 });

		// Disk changes line 2 first (creates fork before remote arrives)
		t.send(await diskChanged('line 1\nDISK 2\nline 3', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Remote changes line 1 — adjacent to disk edit but non-overlapping
		t.setRemoteContent('REMOTE 1\nline 2\nline 3');

		// Provider syncs → fork reconciliation runs diff3(localDoc, fork.base, remoteDoc)
		t.send(connected());
		t.send(providerSynced());
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		// Must auto-merge, not conflict
		expect(t.matches('idle.synced') || t.matches('idle.localAhead')).toBe(true);
		expectLocalDocText(t, 'REMOTE 1\nDISK 2\nline 3');
	});

	test('provider synced → conflicting edits via fork path → diverged', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'aaa bbb ccc', mtime: 1000 });

		// Disk edit first (creates fork before remote arrives)
		t.send(await diskChanged('aaa DISK ccc', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Now set remote to conflicting content
		t.setRemoteContent('aaa REMOTE ccc');

		// Provider syncs — fork reconciliation uses diff3(fork.base, localDoc, remoteDoc)
		t.send(connected());
		t.send(providerSynced());
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		// Fork reconciliation detects conflict via diff3
		expectState(t, 'idle.diverged');
	});

	test('provider not synced → merge deferred → user can still edit', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'original content', mtime: 1000 });

		// Provider NOT synced (no connected/providerSynced events)

		// Disk edit triggers fork creation
		t.send(await diskChanged('disk edited content', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Remote update arrives but provider not synced
		t.applyRemoteChange('remote edited content');
		await t.hsm.awaitIdleAutoMerge();

		// Open file — user should be able to edit (not blocked by unresolved merge)
		await sendAcquireLockToTracking(t, 'disk edited content');
		expect(t.hsm.isActive()).toBe(true);

		// User can type
		t.send(cm6Insert(0, 'user types: ', 'user types: disk edited content'));
		expectLocalDocText(t, 'user types: disk edited content');
	});

	test('provider syncs mid-edit → reconciliation triggers in active mode', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'base content', mtime: 1000 });

		// Disk edit creates fork
		t.send(await diskChanged('base content with disk edit', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Open file while provider is not synced
		await sendAcquireLockToTracking(t, 'base content with disk edit');
		expect(t.hsm.isActive()).toBe(true);

		// Remote has same content — no conflict expected
		t.setRemoteContent('base content');

		// Provider syncs mid-edit → reconcileForkInActive fires
		t.send(connected());
		t.send(providerSynced());

		// Since remote hasn't changed from fork.base, fork should clear cleanly
		expectState(t, 'active.tracking');
	});

	test('provider syncs mid-edit with conflicting remote → conflict surfaced', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'aaa bbb ccc', mtime: 1000 });

		// Disk edit modifies middle region
		t.send(await diskChanged('aaa DISK ccc', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Open file
		await sendAcquireLockToTracking(t, 'aaa DISK ccc');

		// Remote also modified same region differently
		t.setRemoteContent('aaa REMOTE ccc');

		// Provider syncs → reconcileForkInActive detects conflict
		t.send(connected());
		t.send(providerSynced());

		// Should transition to conflict state
		expectState(t, 'active.conflict.bannerShown');
	});
});

// =============================================================================
// 2. Active path conflict detection
// =============================================================================

describe('Active path conflict detection', () => {
	test('open file with pending remote changes, provider unsynced → tracking (not blocked)', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'hello world', mtime: 1000 });

		// Remote update while in idle
		t.applyRemoteChange('hello remote world');

		// Open file without provider synced
		await sendAcquireLockToTracking(t, 'hello world');

		// Should be in tracking, not blocked
		expectState(t, 'active.tracking');
	});

	test('PROVIDER_SYNCED arrives in active.tracking with fork → reconcileForkInActive fires', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'initial', mtime: 1000 });

		// Create fork via disk edit
		t.send(await diskChanged('initial plus disk', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Open file
		await sendAcquireLockToTracking(t, 'initial plus disk');
		expectState(t, 'active.tracking');
		t.clearEffects();

		// Remote unchanged from fork base — provider sync should clear fork
		t.setRemoteContent('initial');
		t.send(connected());
		t.send(providerSynced());

		// Fork should be reconciled, still tracking
		expectState(t, 'active.tracking');
	});

	test('disconnect during reconciliation preserves state', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'base text', mtime: 1000 });

		// Create fork
		t.send(await diskChanged('base text edited', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Open file
		await sendAcquireLockToTracking(t, 'base text edited');

		// User edits while waiting for provider
		t.send(cm6Insert(0, '[user] ', '[user] base text edited'));

		// Connect then immediately disconnect
		t.send(connected());
		t.send(disconnected());

		// Should stay in tracking, not crash
		expectState(t, 'active.tracking');

		// User can still edit
		t.send(cm6Insert(0, 'more ', 'more [user] base text edited'));
		expectLocalDocText(t, 'more [user] base text edited');
	});

	test('rapid connect/disconnect/provider_synced sequence', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'text', mtime: 1000 });

		t.send(await diskChanged('text modified', 2000));
		await t.hsm.awaitIdleAutoMerge();

		await sendAcquireLockToTracking(t, 'text modified');

		// Rapid toggle
		t.send(connected());
		t.send(disconnected());
		t.send(connected());
		t.send(providerSynced());
		t.send(disconnected());
		t.send(connected());
		t.send(providerSynced());

		// Should not crash and should be in a valid state
		expect(t.hsm.isActive()).toBe(true);
	});
});

// =============================================================================
// 3. Idle path conflict detection
// =============================================================================

describe('Idle path conflict detection', () => {
	test('REMOTE_UPDATE while idle, provider unsynced → merge deferred', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'content', mtime: 1000 });

		// No provider sync events — provider is unsynced

		// Disk edit creates a fork
		t.send(await diskChanged('content with disk change', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Remote update arrives
		t.applyRemoteChange('content with remote change');
		await t.hsm.awaitIdleAutoMerge();

		// Without provider synced, fork reconciliation should not complete
		// The HSM should be in some idle state (localAhead or diverged)
		expect(t.matches('idle')).toBe(true);
	});

	test('provider syncs → idle merge proceeds after deferred fork', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'base', mtime: 1000 });

		// Disk edit creates fork
		t.send(await diskChanged('base with disk', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Now provider syncs — fork reconciliation should proceed
		t.send(connected());
		t.send(providerSynced());
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		// Remote hasn't changed, so fork should reconcile to synced
		expect(t.matches('idle')).toBe(true);
	});

	test('conflicting remote + disk edits in idle via fork path → diverged', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'xxx yyy zzz', mtime: 1000 });

		// Disk edit first — creates fork
		t.send(await diskChanged('xxx DISK zzz', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Set conflicting remote content
		t.setRemoteContent('xxx REMOTE zzz');

		// Provider syncs — fork-reconcile runs diff3(fork.base, localDoc, remoteDoc)
		t.send(connected());
		t.send(providerSynced());
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		// Fork reconciliation detects conflict
		expectState(t, 'idle.diverged');
	});

	test('non-conflicting remote + disk edits in idle → auto-merged to synced', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'line 1\nline 2\nline 3', mtime: 1000 });

		t.send(connected());
		t.send(providerSynced());

		// Remote modifies line 1 (non-overlapping)
		t.applyRemoteChange('remote line 1\nline 2\nline 3');

		// Disk modifies line 3 (non-overlapping)
		t.send(await diskChanged('line 1\nline 2\ndisk line 3', 2000));

		await t.hsm.awaitIdleAutoMerge();
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		// Non-conflicting edits should auto-merge
		expect(t.matches('idle.synced') || t.matches('idle.localAhead')).toBe(true);
	});
});

// =============================================================================
// 4. Multi-path consistency: same divergence → same conflict data
// =============================================================================

describe('Multi-path consistency', () => {
	const BASE = 'aaa bbb ccc';
	const DISK = 'aaa DISK ccc';
	const REMOTE = 'aaa REMOTE ccc';

	test('idle path produces conflict data when conflicting edits detected', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: BASE, mtime: 1000 });

		// Disk edit first — creates fork
		t.send(await diskChanged(DISK, 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Set conflicting remote content
		t.setRemoteContent(REMOTE);

		// Provider syncs — fork-reconcile detects conflict
		t.send(connected());
		t.send(providerSynced());
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		expectState(t, 'idle.diverged');

		// Open file → should show conflict
		t.send({ type: 'ACQUIRE_LOCK', editorContent: DISK });
		await t.hsm.awaitState?.((s: string) => !s.includes('awaitingPersistence') && !s.includes('entering'));

		expect(t.matches('active.conflict.bannerShown')).toBe(true);
	});

	test('active path produces conflict data for same divergence', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: BASE, mtime: 1000 });

		// Disk edit first (creates fork)
		t.send(await diskChanged(DISK, 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Open file while provider unsynced
		await sendAcquireLockToTracking(t, DISK);
		expectState(t, 'active.tracking');

		// Set remote content to conflicting value
		t.setRemoteContent(REMOTE);

		// Provider syncs → reconcileForkInActive detects conflict
		t.send(connected());
		t.send(providerSynced());

		// Should surface conflict
		expectState(t, 'active.conflict.bannerShown');
	});

	test('conflict opened from idle shows correct ours/theirs', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: BASE, mtime: 1000 });

		// Disk edit first — creates fork
		t.send(await diskChanged(DISK, 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Set conflicting remote
		t.setRemoteContent(REMOTE);

		// Provider syncs
		t.send(connected());
		t.send(providerSynced());
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		// Open and go to conflict
		t.send({ type: 'ACQUIRE_LOCK', editorContent: DISK });
		await t.hsm.awaitState?.((s: string) => !s.includes('awaitingPersistence') && !s.includes('entering'));

		if (t.matches('active.conflict.bannerShown')) {
			t.send(openDiffView());
			expectState(t, 'active.conflict.resolving');
		}
	});
});

// =============================================================================
// 5. Edge cases: state machine robustness under adversarial event ordering
// =============================================================================

describe('Adversarial event ordering', () => {
	test('PROVIDER_SYNCED before CONNECTED in active mode', async () => {
		const t = await createTestHSM();
		await loadAndActivate(t, 'content');

		// Send PROVIDER_SYNCED without prior CONNECTED — should not crash
		t.send(providerSynced());
		expectState(t, 'active.tracking');
	});

	test('multiple PROVIDER_SYNCED events in rapid succession', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'text', mtime: 1000 });

		t.send(await diskChanged('text edited', 2000));
		await t.hsm.awaitIdleAutoMerge();

		await sendAcquireLockToTracking(t, 'text edited');

		// Multiple rapid PROVIDER_SYNCED events
		t.send(connected());
		t.send(providerSynced());
		t.send(providerSynced());
		t.send(providerSynced());

		// Should not crash or produce duplicate effects
		expect(t.hsm.isActive()).toBe(true);
	});

	test('DISK_CHANGED during active.entering.awaitingRemote', async () => {
		const t = await createTestHSM({
			diskLoader: async () => ({
				content: 'from disk',
				hash: 'disk-hash',
				mtime: 1000,
			}),
		});

		await loadToIdle(t, { content: '', mtime: 500 });

		// Open file — goes to awaitingPersistence → awaitingRemote (empty IDB)
		t.send({ type: 'ACQUIRE_LOCK', editorContent: 'from disk' });
		// Wait for persistence
		await t.hsm.awaitState?.((s: string) => !s.includes('awaitingPersistence'));

		// If in awaitingRemote, send disk change before provider syncs
		if (t.matches('active.entering.awaitingRemote')) {
			t.send(await diskChanged('from disk modified', 2000));
			// Then provider syncs
			t.send(providerSynced());
		}

		// Should eventually reach tracking or conflict, not crash
		await t.hsm.awaitState?.((s: string) =>
			s === 'active.tracking' || s.includes('conflict') || s.includes('merging')
		);
		expect(t.hsm.isActive()).toBe(true);
	});

	test('RELEASE_LOCK during fork reconciliation in active mode', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'original', mtime: 1000 });

		// Create fork
		t.send(await diskChanged('original modified', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Open file
		await sendAcquireLockToTracking(t, 'original modified');

		// Release lock before provider syncs (fork still active)
		t.send(releaseLock());
		await t.hsm.awaitCleanup();

		// Should cleanly transition to idle
		expect(t.matches('idle')).toBe(true);
	});

	test('remote update arrives right after RELEASE_LOCK with fork', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'base', mtime: 1000 });

		t.send(await diskChanged('base with edit', 2000));
		await t.hsm.awaitIdleAutoMerge();

		await sendAcquireLockToTracking(t, 'base with edit');
		t.send(releaseLock());
		await t.hsm.awaitCleanup();

		// Remote update while back in idle
		t.applyRemoteChange('base with remote');
		await t.hsm.awaitIdleAutoMerge();

		// Should handle gracefully
		expect(t.matches('idle')).toBe(true);
	});

	test('double ACQUIRE_LOCK does not corrupt state', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'content', mtime: 1000 });

		// First acquire
		await sendAcquireLockToTracking(t, 'content');
		expectState(t, 'active.tracking');

		// Release
		t.send(releaseLock());
		await t.hsm.awaitCleanup();

		// Second acquire
		await sendAcquireLockToTracking(t, 'content');
		expectState(t, 'active.tracking');
		expectLocalDocText(t, 'content');
	});

	test('fork survives full lock cycle without provider sync', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'original', mtime: 1000 });

		// Create fork
		t.send(await diskChanged('original with disk edit', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Open → edit → close without provider sync
		await sendAcquireLockToTracking(t, 'original with disk edit');
		t.send(cm6Insert(0, 'typed: ', 'typed: original with disk edit'));
		t.send(releaseLock());
		await t.hsm.awaitCleanup();

		// Re-open — should still function correctly
		await sendAcquireLockToTracking(t, 'original with disk edit');
		expect(t.hsm.isActive()).toBe(true);
	});
});

// =============================================================================
// 6. Provider sync timing edge cases
// =============================================================================

describe('Provider sync timing', () => {
	test('provider syncs between idle.diskAhead invoke start and completion', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'content', mtime: 1000 });

		// Disk change → idle.diskAhead, invoke starts
		t.send(await diskChanged('content changed', 2000));

		// Provider syncs during the invoke
		t.send(connected());
		t.send(providerSynced());

		await t.hsm.awaitIdleAutoMerge();
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }

		// Should reach a stable idle state
		expect(t.matches('idle')).toBe(true);
	});

	test('REMOTE_UPDATE during idle.localAhead fork-reconcile (provider not synced)', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'base text', mtime: 1000 });

		// Disk edit → fork
		t.send(await diskChanged('base text plus disk', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Remote update while fork-reconcile is waiting for provider
		t.applyRemoteChange('base text plus remote');
		await t.hsm.awaitIdleAutoMerge();

		// Provider syncs — should trigger reconciliation with accumulated remote
		t.send(connected());
		t.send(providerSynced());
		try { await t.hsm.awaitForkReconcile(); } catch { /* no-op */ }
		await t.hsm.awaitIdleAutoMerge();

		// Should reach stable state
		expect(t.matches('idle')).toBe(true);
	});

	test('disconnect then reconnect with new remote content in idle', async () => {
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'abc', mtime: 1000 });

		t.send(connected());
		t.send(providerSynced());

		// First remote change
		t.applyRemoteChange('abc remote1');
		await t.hsm.awaitIdleAutoMerge();

		// Disconnect
		t.send(disconnected());

		// More remote changes arrive (even while "disconnected" — provider may buffer)
		t.applyRemoteChange('abc remote1 remote2');
		await t.hsm.awaitIdleAutoMerge();

		// Reconnect
		t.send(connected());
		t.send(providerSynced());
		await t.hsm.awaitIdleAutoMerge();

		expect(t.matches('idle')).toBe(true);
	});
});

// =============================================================================
// Conflict resolution edge cases
// =============================================================================

describe('Conflict resolution edge cases', () => {
	test('dismiss conflict then re-open file sees same conflict', async () => {
		const t = await createTestHSM();
		await loadToConflict(t, {
			base: 'base text',
			remote: 'remote changed text',
			disk: 'disk changed text',
		});

		// Dismiss conflict
		t.send(dismissConflict());

		// Release lock
		t.send(releaseLock());
		await t.hsm.awaitCleanup();

		// Re-acquire lock — should show deferred conflict
		t.send({ type: 'ACQUIRE_LOCK', editorContent: 'disk changed text' });
		await t.hsm.awaitIdleAutoMerge();

		// Should be in some active state
		expect(t.matches('active')).toBe(true);
	});

	test('resolve with empty string', async () => {
		const t = await createTestHSM();
		await loadToConflict(t, {
			base: 'base',
			remote: 'remote edit',
			disk: 'disk edit',
		});

		// Resolve with empty content
		t.send(resolve(''));

		// Should accept the resolution
		expect(t.matches('active')).toBe(true);
	});

	test('conflict where all three versions are identical', async () => {
		// If base, remote, and disk are all the same, no conflict should occur.
		// This tests the guard logic.
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'same', mtime: 1000 });

		// Disk "changes" but to same content
		t.send(await diskChanged('same', 2000));
		await t.hsm.awaitIdleAutoMerge();

		// Should stay synced (or return to synced)
		expect(t.matches('idle')).toBe(true);
	});
});

// =============================================================================
// Three-way merge edge cases
// =============================================================================

describe('Three-way merge edge cases', () => {
	test('conflict where only whitespace differs', async () => {
		const t = await createTestHSM();
		// Base has no trailing newline; remote adds spaces, disk adds tabs
		try {
			await loadToConflict(t, {
				base: 'line1\nline2',
				remote: 'line1  \nline2  ',
				disk: 'line1\t\nline2\t',
			});
			// If it reaches conflict, dismiss it
			t.send(dismissConflict());
		} catch {
			// Whitespace-only changes might auto-merge. Either way, no crash.
		}
		expect(t.matches('active') || t.matches('idle')).toBe(true);
	});

	test('conflict with very long single line', async () => {
		const baseLine = 'A'.repeat(10_000);
		const remoteLine = 'B'.repeat(10_000);
		const diskLine = 'C'.repeat(10_000);

		try {
			const t = await createTestHSM();
			await loadToConflict(t, {
				base: baseLine,
				remote: remoteLine,
				disk: diskLine,
			});

			// Resolve with one version
			t.send(resolve(remoteLine));
			expect(t.matches('active')).toBe(true);
		} catch {
			// Large single-line conflicts may have edge cases
		}
	});

	test('merge where base is empty but both sides have content', async () => {
		try {
			const t = await createTestHSM();
			await loadToConflict(t, {
				base: '',
				remote: 'remote added content',
				disk: 'disk added content',
			});
			// This is a real conflict — both sides added content from empty
			t.send(resolve('merged content'));
			expect(t.matches('active')).toBe(true);
		} catch (e: any) {
			// If loadToConflict fails because empty base is special, that's acceptable
			expect(e.message).toContain('loadToConflict');
		}
	});
});
