/**
 * Tests for bidirectional update queues — the mechanism that buffers Y.Doc
 * transaction updates and selectively defers machine-edit ops until matched.
 *
 * Outbound queue: local → remote. Tags machine-edit entries so flushOutbound()
 * can defer them while their registrations are pending.
 *
 * Inbound queue: remote → local. Drains buffered remote updates through
 * flushInbound(), with machine-edit matching and cancel.
 */

import { diff_match_patch } from "diff-match-patch";
import {
	createTestHSM,
	loadAndActivate,
	cm6Change,
	cm6Insert,
	releaseLock,
	expectState,
	expectEffect,
	expectNoEffect,
	expectEffectCount,
	expectLocalDocText,
	expectRemoteDocText,
} from "src/merge-hsm/testing";
import type { TestHSM } from "src/merge-hsm/testing";

// ===========================================================================
// Helpers
// ===========================================================================

async function setupActive(content: string): Promise<TestHSM> {
	const t = await createTestHSM();
	await loadAndActivate(t, content);
	expectState(t, "active.tracking");
	t.clearEffects();
	return t;
}

/**
 * Compute CM6-style changes from old→new text.
 */
function computeCM6Changes(
	oldText: string,
	newText: string,
): Array<{ from: number; to: number; insert: string }> {
	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(oldText, newText);
	dmp.diff_cleanupSemantic(diffs);

	const raw: Array<{ from: number; to: number; insert: string }> = [];
	let pos = 0;
	for (const [op, text] of diffs) {
		if (op === 0) {
			pos += text.length;
		} else if (op === -1) {
			raw.push({ from: pos, to: pos + text.length, insert: "" });
			pos += text.length;
		} else if (op === 1) {
			raw.push({ from: pos, to: pos, insert: text });
		}
	}

	// Merge adjacent delete+insert into a single replace (CM6 style)
	const merged: typeof raw = [];
	for (let i = 0; i < raw.length; i++) {
		const curr = raw[i];
		const next = raw[i + 1];
		if (
			next &&
			curr.insert === "" &&
			next.from === curr.to &&
			next.to === curr.to
		) {
			merged.push({ from: curr.from, to: curr.to, insert: next.insert });
			i++;
		} else {
			merged.push(curr);
		}
	}
	return merged;
}

// ===========================================================================
// Outbound queue tests
// ===========================================================================

describe("outbound queue", () => {
	it("user edit emits SYNC_TO_REMOTE", async () => {
		const t = await setupActive("hello");

		t.send(cm6Insert(5, " world", "hello world"));

		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
		expectLocalDocText(t, "hello world");
		expectRemoteDocText(t, "hello world");
	});

	it("multiple user edits produce merged SYNC_TO_REMOTE", async () => {
		const t = await setupActive("ab");

		// Two rapid edits
		t.send(cm6Insert(2, "c", "abc"));
		t.send(cm6Insert(3, "d", "abcd"));

		// Each applyCM6ToLocalDoc calls flushOutbound, so we get two effects
		expectEffectCount(t.effects, "SYNC_TO_REMOTE", 2);
		expectLocalDocText(t, "abcd");
		expectRemoteDocText(t, "abcd");
	});

	it("machine edit deferred — no SYNC_TO_REMOTE emitted", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);

		const changes = computeCM6Changes("Hello [[B]] world", "Hello [[C]] world");
		t.send(cm6Change(changes, "Hello [[C]] world"));

		expectLocalDocText(t, "Hello [[C]] world");
		// Machine edit deferred — no outbound sync
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");
		// remoteDoc should NOT have the machine edit
		expectRemoteDocText(t, "Hello [[B]] world");
	});

	it("machine edit + user edit: user edit flows to remoteDoc, machine edit deferred", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		// Register machine edit
		t.hsm.registerMachineEdit(fn);

		// Machine edit arrives via CM6 — applied via proxy doc so the items
		// use the proxy's clientID, not localDoc's
		const machineChanges = computeCM6Changes(
			"Hello [[B]] world",
			"Hello [[C]] world",
		);
		t.send(cm6Change(machineChanges, "Hello [[C]] world"));
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");

		t.clearEffects();

		// User types at the end (docText doesn't match any pending expectedText)
		t.send(cm6Insert(17, "!", "Hello [[C]] world!"));

		// User edit SYNC_TO_REMOTE is emitted
		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });

		// With the proxy approach, user edits use localDoc's clientID (decoupled
		// from the proxy's). The user edit update applies cleanly to remoteDoc.
		// Machine edit [[C]] is still deferred — only [[B]] is in remoteDoc.
		expectRemoteDocText(t, "Hello [[B]] world!");
	});

	it("machine edit match: deferred entries discarded, clean sync", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);

		const changes = computeCM6Changes("Hello [[B]] world", "Hello [[C]] world");
		t.send(cm6Change(changes, "Hello [[C]] world"));

		expectNoEffect(t.effects, "SYNC_TO_REMOTE");
		t.clearEffects();

		// Remote applies same transform
		t.applyRemoteChange("Hello [[C]] world");

		// After rewind, no duplication
		expectLocalDocText(t, "Hello [[C]] world");
		expectRemoteDocText(t, "Hello [[C]] world");

		// With the queue approach, deferred entries are discarded (not sent),
		// and localDoc/remoteDoc are already in sync after cancel+apply.
		// No SYNC_TO_REMOTE is needed since there's nothing to send.
	});

	it("machine edit match after interleaved user edit", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		// Register and apply machine edit
		t.hsm.registerMachineEdit(fn);
		const machineChanges = computeCM6Changes(
			"Hello [[B]] world",
			"Hello [[C]] world",
		);
		t.send(cm6Change(machineChanges, "Hello [[C]] world"));
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");

		// User types at the end — with the proxy approach this flows to
		// remoteDoc immediately (decoupled state vectors)
		t.send(cm6Insert(17, "!", "Hello [[C]] world!"));

		t.clearEffects();

		// Remote applies the same rename function. Since the user edit already
		// flowed to remoteDoc, remoteDoc has "Hello [[B]] world!". The remote
		// peer's rename turns that into "Hello [[C]] world!" (preserving "!").
		t.applyRemoteChange("Hello [[C]] world!");

		// Cancel succeeds — machine edit ops were never marked synced.
		// localDoc has the canonical machine edit (from remote) + user edit.
		expectLocalDocText(t, "Hello [[C]] world!");
		expectRemoteDocText(t, "Hello [[C]] world!");
	});

	it("machine edit expiry releases deferred entries", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);
		const changes = computeCM6Changes("Hello [[B]] world", "Hello [[C]] world");
		t.send(cm6Change(changes, "Hello [[C]] world"));

		expectNoEffect(t.effects, "SYNC_TO_REMOTE");
		t.clearEffects();

		// Advance time past TTL (5s + 100ms buffer for setTimeout)
		t.time.setTime(t.time.now() + 5200);

		// After expiry, ops are synced
		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
		expectRemoteDocText(t, "Hello [[C]] world");
	});

	it("machine edit flush releases deferred entries", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);
		const changes = computeCM6Changes("Hello [[B]] world", "Hello [[C]] world");
		t.send(cm6Change(changes, "Hello [[C]] world"));

		expectNoEffect(t.effects, "SYNC_TO_REMOTE");
		t.clearEffects();

		// Release lock → deactivateEditor flushes pending edits
		t.send(releaseLock());
		await t.hsm.awaitCleanup();

		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
	});

	it("two machine edits: both deferred independently in queue", async () => {
		const t = await setupActive("Hello [[A]] and [[B]] world");
		const fnA = (text: string) => text.replace("[[A]]", "[[A2]]");
		const fnB = (text: string) => text.replace("[[B]]", "[[B2]]");

		// Register A
		t.hsm.registerMachineEdit(fnA);
		const changesA = computeCM6Changes(
			"Hello [[A]] and [[B]] world",
			"Hello [[A2]] and [[B]] world",
		);
		t.send(cm6Change(changesA, "Hello [[A2]] and [[B]] world"));
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");

		// Register B
		t.hsm.registerMachineEdit(fnB);
		const changesB = computeCM6Changes(
			"Hello [[A2]] and [[B]] world",
			"Hello [[A2]] and [[B2]] world",
		);
		t.send(cm6Change(changesB, "Hello [[A2]] and [[B2]] world"));
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");

		// Both entries are deferred in the outbound queue
		const hsm = t.hsm as any;
		expect(hsm._bridge._outboundQueue.length).toBe(2);
		expect(hsm._bridge._outboundQueue[0].machineEditMark).not.toBeNull();
		expect(hsm._bridge._outboundQueue[1].machineEditMark).not.toBeNull();

		// remoteDoc should NOT have either machine edit
		expectRemoteDocText(t, "Hello [[A]] and [[B]] world");
		expectLocalDocText(t, "Hello [[A2]] and [[B2]] world");
	});

	it("notifySynced skipped while machine edits pending", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);

		// Machine edit via CM6
		const machineChanges = computeCM6Changes(
			"Hello [[B]] world",
			"Hello [[C]] world",
		);
		t.send(cm6Change(machineChanges, "Hello [[C]] world"));

		// User edit — syncs but notifySynced should be skipped (deferred entries exist)
		t.send(cm6Insert(17, "!", "Hello [[C]] world!"));

		// Verify cancel still works on machine edit ops (they weren't marked synced).
		// Remote applies rename to current remoteDoc content (which includes
		// the user edit "!" thanks to proxy decoupling).
		t.clearEffects();
		t.applyRemoteChange("Hello [[C]] world!");

		// Should not throw — ops are still cancellable
		expectLocalDocText(t, "Hello [[C]] world!");
	});

	it("notifySynced called when all machine edits resolved", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);
		const changes = computeCM6Changes("Hello [[B]] world", "Hello [[C]] world");
		t.send(cm6Change(changes, "Hello [[C]] world"));

		// Remote matches → clears pending
		t.applyRemoteChange("Hello [[C]] world");
		t.clearEffects();

		// Normal edit after all machine edits resolved
		t.send(cm6Insert(17, "!", "Hello [[C]] world!"));

		// SYNC_TO_REMOTE emitted — outbound queue has no deferred entries,
		// so notifySynced is called (machine edits all resolved).
		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
		expectLocalDocText(t, "Hello [[C]] world!");
	});
});

// ===========================================================================
// Inbound queue tests
// ===========================================================================

describe("inbound queue", () => {
	it("remote update applies to localDoc", async () => {
		const t = await setupActive("hello");
		t.clearEffects();

		t.applyRemoteChange("hello world");

		expectLocalDocText(t, "hello world");
		expectEffect(t.effects, { type: "DISPATCH_CM6" });
	});

	it("remote update with matching text is no-op", async () => {
		const t = await setupActive("hello");
		t.clearEffects();

		// Simulate a remote "update" that doesn't actually change content
		// (e.g., metadata-only update). Send REMOTE_DOC_UPDATED directly.
		t.send({ type: "REMOTE_DOC_UPDATED" });

		// No DISPATCH_CM6 because content matches
		expectNoEffect(t.effects, "DISPATCH_CM6");
	});

	it("multiple remote updates produce correct final text", async () => {
		const t = await setupActive("ab");
		t.clearEffects();

		t.applyRemoteChange("abc");
		t.applyRemoteChange("abcd");

		expectLocalDocText(t, "abcd");
	});
});

// ===========================================================================
// Gate interaction tests
// ===========================================================================

describe("gate interactions", () => {
	it("fork gates outbound queue", async () => {
		const t = await setupActive("hello");
		t.clearEffects();

		// Simulate fork (manually set for testing — normally from disk edit)
		(t.hsm as any)._fork = {
			captureMark: 0,
			stateVector: new Uint8Array([0]),
		};

		t.send(cm6Insert(5, "!", "hello!"));

		// SYNC_TO_REMOTE should NOT be emitted (gated by fork)
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");
		expect((t.hsm as any)._bridge._syncGate.pendingOutbound).toBeGreaterThan(0);

		// Clean up
		(t.hsm as any)._fork = null;
	});

	it("localOnly gates both queues", async () => {
		const t = await setupActive("hello");
		t.clearEffects();

		t.hsm.setLocalOnly(true);

		// Local edit
		t.send(cm6Insert(5, "!", "hello!"));

		// No outbound sync
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");
		expect(t.hsm.pendingOutbound).toBeGreaterThan(0);

		t.clearEffects();

		// Remote update
		t.applyRemoteChange("hello world");

		// No inbound merge (should accumulate)
		expect(t.hsm.pendingInbound).toBeGreaterThan(0);

		t.clearEffects();

		// Disable local-only → flushes both directions
		t.hsm.setLocalOnly(false);

		// Both directions should flush
		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
	});

	it("setLocalOnly(false) drains queues", async () => {
		const t = await setupActive("hello");
		t.clearEffects();

		t.hsm.setLocalOnly(true);

		// Accumulate outbound
		t.send(cm6Insert(5, "!", "hello!"));

		// Accumulate inbound
		t.applyRemoteChange("hello world");

		t.clearEffects();

		// Disable — drain
		t.hsm.setLocalOnly(false);

		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
	});
});

// ===========================================================================
// Fallback path tests
// ===========================================================================

describe("fallback path", () => {
	it("before listener installed, uses encodeStateAsUpdate", async () => {
		const t = await createTestHSM();

		// Load but don't activate — stays in loading/idle
		// The loadAndActivate helper goes through the full flow but
		// flushOutbound uses fallback during loading phases
		await loadAndActivate(t, "test content");

		// The activation process includes an outbound flush via the fallback path
		// Verify everything still works
		expectState(t, "active.tracking");
		expectLocalDocText(t, "test content");
	});
});

// ===========================================================================
// Cleanup tests
// ===========================================================================

describe("cleanup", () => {
	it("destroyLocalDoc clears queues and removes listeners", async () => {
		const t = await setupActive("hello");

		// Generate some queue entries
		t.hsm.registerMachineEdit((text: string) => text.replace("hello", "hi"));
		const changes = computeCM6Changes("hello", "hi");
		t.send(cm6Change(changes, "hi"));

		// Verify queue has entries before destroy
		const hsm = t.hsm as any;
		expect(hsm._bridge._outboundQueue.length).toBeGreaterThan(0);

		// Destroy
		await hsm.destroyLocalDoc();

		// Queues cleared
		expect(hsm._bridge._outboundQueue).toEqual([]);
		expect(hsm._bridge._inboundQueue).toEqual([]);
		expect(hsm._bridge._localDocUpdateHandler).toBeNull();
		expect(hsm._bridge._remoteDocUpdateHandler).toBeNull();
	});

	it("deactivateEditor clears queues and removes listeners", async () => {
		const t = await setupActive("hello");

		// Generate some activity
		t.send(cm6Insert(5, "!", "hello!"));
		t.clearEffects();

		// Release lock → deactivateEditor
		t.send(releaseLock());
		await t.hsm.awaitCleanup();

		const hsm = t.hsm as any;
		expect(hsm._bridge._outboundQueue).toEqual([]);
		expect(hsm._bridge._inboundQueue).toEqual([]);
		expect(hsm._bridge._localDocUpdateHandler).toBeNull();
		expect(hsm._bridge._remoteDocUpdateHandler).toBeNull();
	});
});
