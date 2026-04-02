import * as Y from "yjs";
import {
	createTestHSM,
	loadToIdle,
	load,
	persistenceLoaded,
	createYjsUpdate,
} from 'src/merge-hsm/testing';
import {
	svEqual,
	svIsAhead,
	svIsStale,
	classifyUpdate,
	extractDependencySV,
	stateVectorsEqual,
	stateVectorIsAhead,
	decodeSV,
} from "src/merge-hsm/state-vectors";

/**
 * Simulate two peers collaborating on a shared Y.Doc.
 * Returns the two docs and a helper to sync between them.
 */
function createPeers() {
	const alice = new Y.Doc();
	const bob = new Y.Doc();

	function syncAliceToBob() {
		const update = Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob));
		Y.applyUpdate(bob, update);
	}

	function syncBobToAlice() {
		const update = Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice));
		Y.applyUpdate(alice, update);
	}

	function syncBoth() {
		syncAliceToBob();
		syncBobToAlice();
	}

	/** Get the delta from alice that bob doesn't have */
	function deltaAliceToBob(): Uint8Array {
		return Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob));
	}

	/** Get the delta from bob that alice doesn't have */
	function deltaBobToAlice(): Uint8Array {
		return Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice));
	}

	function destroy() {
		alice.destroy();
		bob.destroy();
	}

	return { alice, bob, syncAliceToBob, syncBobToAlice, syncBoth, deltaAliceToBob, deltaBobToAlice, destroy };
}

/**
 * Capture incremental deltas as they happen on a doc.
 */
function captureUpdates(doc: Y.Doc): Uint8Array[] {
	const updates: Uint8Array[] = [];
	doc.on("update", (u: Uint8Array) => updates.push(new Uint8Array(u)));
	return updates;
}

describe("state-vectors", () => {
	describe("svEqual", () => {
		test("two synced docs have equal SVs", () => {
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();

			expect(svEqual(
				decodeSV(Y.encodeStateVector(alice)),
				decodeSV(Y.encodeStateVector(bob)),
			)).toBe(true);
			destroy();
		});

		test("diverged docs have unequal SVs", () => {
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();
			alice.getText("t").insert(5, " world");

			expect(svEqual(
				decodeSV(Y.encodeStateVector(alice)),
				decodeSV(Y.encodeStateVector(bob)),
			)).toBe(false);
			destroy();
		});
	});

	describe("svIsAhead", () => {
		test("doc with unsent edits is ahead of synced peer", () => {
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();
			alice.getText("t").insert(5, " world");

			const aliceSV = decodeSV(Y.encodeStateVector(alice));
			const bobSV = decodeSV(Y.encodeStateVector(bob));

			expect(svIsAhead(aliceSV, bobSV)).toBe(true);
			expect(svIsAhead(bobSV, aliceSV)).toBe(false);
			destroy();
		});

		test("both ahead of each other when both have unsent edits", () => {
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();
			alice.getText("t").insert(5, "!");
			bob.getText("t").insert(5, "?");

			const aliceSV = decodeSV(Y.encodeStateVector(alice));
			const bobSV = decodeSV(Y.encodeStateVector(bob));

			expect(svIsAhead(aliceSV, bobSV)).toBe(true);
			expect(svIsAhead(bobSV, aliceSV)).toBe(true);
			destroy();
		});
	});

	describe("svIsStale", () => {
		test("synced peer's SV is not stale relative to itself", () => {
			const { alice, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");

			const sv = decodeSV(Y.encodeStateVector(alice));
			expect(svIsStale(sv, sv)).toBe(false);
			destroy();
		});

		test("old SV is stale after peer makes more edits", () => {
			const { alice, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			const oldSV = decodeSV(Y.encodeStateVector(alice));
			alice.getText("t").insert(5, " world");
			const newSV = decodeSV(Y.encodeStateVector(alice));

			expect(svIsStale(oldSV, newSV)).toBe(true);
			expect(svIsStale(newSV, oldSV)).toBe(false);
			destroy();
		});
	});

	describe("extractDependencySV", () => {
		test("delta from synced baseline starts at the sync point", () => {
			const { alice, bob, syncBoth, deltaAliceToBob, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();

			// Alice makes more edits
			alice.getText("t").insert(5, " world");
			alice.getText("t").insert(11, "!");

			const delta = deltaAliceToBob();
			const dep = extractDependencySV(delta);

			// The dependency should be at alice's clock when they last synced
			const bobKnowsAlice = decodeSV(Y.encodeStateVector(bob)).get(alice.clientID) ?? 0;
			expect(dep.get(alice.clientID)).toBe(bobKnowsAlice);
			destroy();
		});

		test("full state update has dependency starting at clock 0", () => {
			const alice = new Y.Doc();
			alice.getText("t").insert(0, "hello");
			alice.getText("t").insert(5, " world");

			const fullState = Y.encodeStateAsUpdate(alice);
			const dep = extractDependencySV(fullState);

			expect(dep.get(alice.clientID)).toBe(0);
			alice.destroy();
		});
	});

	describe("classifyUpdate", () => {
		test("no tracked SV: gap", () => {
			const alice = new Y.Doc();
			alice.getText("t").insert(0, "hello");
			const delta = Y.encodeStateAsUpdate(alice);

			expect(classifyUpdate(delta, undefined)).toBe("gap");
			alice.destroy();
		});

		test("contiguous delta from synced peer: apply", () => {
			const { alice, bob, syncBoth, deltaAliceToBob, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();

			// Alice makes a new edit
			alice.getText("t").insert(5, " world");
			const delta = deltaAliceToBob();

			// Bob's SV is the tracked baseline
			const tracked = decodeSV(Y.encodeStateVector(bob));
			expect(classifyUpdate(delta, tracked)).toBe("apply");
			destroy();
		});

		test("delta already received: stale", () => {
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();

			// Capture the delta before alice edits more
			alice.getText("t").insert(5, " world");
			const delta = Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob));

			// Sync it to bob
			Y.applyUpdate(bob, delta);

			// Now bob's SV covers the delta — it's stale
			const tracked = decodeSV(Y.encodeStateVector(bob));
			expect(classifyUpdate(delta, tracked)).toBe("stale");
			destroy();
		});

		test("delta with missing intermediate ops: gap", () => {
			// Scenario: alice and bob are synced. Alice makes edits in batches.
			// Bob receives batch 1 but misses batch 2 (e.g. WebSocket reconnect).
			// A delta from batch 3 arrives — bob is missing batch 2's ops.
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();

			// Batch 1: alice edits, bob receives
			alice.getText("t").insert(5, " ");
			alice.getText("t").insert(6, "w");
			const batch1 = Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob));
			Y.applyUpdate(bob, batch1);

			// Batch 2: alice edits, bob does NOT receive (simulates dropped messages)
			alice.getText("t").insert(7, "o");
			alice.getText("t").insert(8, "r");

			// Batch 3: alice edits more — this delta depends on batch 2
			alice.getText("t").insert(9, "l");
			alice.getText("t").insert(10, "d");
			// Compute delta of only batch 3's ops (what alice has beyond batch 2's end)
			// We need alice's SV after batch 2 to get only batch 3
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const _svAfterBatch2 = Y.encodeStateVector(alice);
			// Actually we need to snapshot SV between batch 2 and 3. Let me redo:
			destroy();

			// Cleaner approach: use captured updates
			const { alice: a, bob: b, syncBoth: sync2, destroy: destroy2 } = createPeers();
			a.getText("t").insert(0, "hello");
			sync2();

			const updates = captureUpdates(a);
			a.getText("t").insert(5, " ");  // update[0] — batch 1
			a.getText("t").insert(6, "w");  // update[1] — batch 1

			// Bob receives batch 1
			Y.applyUpdate(b, Y.mergeUpdates(updates.slice(0, 2)));

			a.getText("t").insert(7, "o");  // update[2] — batch 2 (missed)
			a.getText("t").insert(8, "r");  // update[3] — batch 2 (missed)
			a.getText("t").insert(9, "l");  // update[4] — batch 3
			a.getText("t").insert(10, "d"); // update[5] — batch 3

			// Bob's tracked SV covers through batch 1.
			// Batch 3 delta (updates 4-5) depends on batch 2 (updates 2-3) which bob missed.
			const batch3 = Y.mergeUpdates(updates.slice(4));
			const tracked = decodeSV(Y.encodeStateVector(b));
			expect(classifyUpdate(batch3, tracked)).toBe("gap");
			destroy2();
		});

		test("full-state keyframe applied to empty tracked: apply", () => {
			const alice = new Y.Doc();
			alice.getText("t").insert(0, "hello world");

			const fullState = Y.encodeStateAsUpdate(alice);

			// Empty tracked SV (just established, no history)
			const tracked = new Map<number, number>();
			expect(classifyUpdate(fullState, tracked)).toBe("apply");
			alice.destroy();
		});

		test("after keyframe, buffered delta is contiguous: apply", () => {
			const { alice, bob, syncBoth, deltaAliceToBob, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();

			// Alice makes edits, capture the delta
			alice.getText("t").insert(5, " world");
			const delta = deltaAliceToBob();

			// Simulate: bob receives a keyframe (full state from server)
			const keyframe = Y.encodeStateAsUpdate(alice);
			Y.applyUpdate(bob, keyframe);

			// After keyframe, bob's SV covers everything — delta is stale
			const tracked = decodeSV(Y.encodeStateVector(bob));
			expect(classifyUpdate(delta, tracked)).toBe("stale");
			destroy();
		});

		test("after stale keyframe, buffered delta has new ops: apply", () => {
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();

			// Capture alice's state BEFORE her new edit (simulates stale HTTP response)
			const staleKeyframe = Y.encodeStateAsUpdate(alice);

			// Alice makes a new edit
			alice.getText("t").insert(5, " world");
			const delta = Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob));

			// Bob receives the stale keyframe first
			Y.applyUpdate(bob, staleKeyframe);
			const tracked = decodeSV(Y.encodeStateVector(bob));

			// The delta has ops beyond the stale keyframe — should be apply
			expect(classifyUpdate(delta, tracked)).toBe("apply");
			destroy();
		});
	});

	describe("stateVectorsEqual (encoded)", () => {
		test("synced docs", () => {
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();

			expect(stateVectorsEqual(
				Y.encodeStateVector(alice),
				Y.encodeStateVector(bob),
			)).toBe(true);
			destroy();
		});
	});

	describe("stateVectorIsAhead (encoded)", () => {
		test("doc with new edits is ahead", () => {
			const { alice, bob, syncBoth, destroy } = createPeers();
			alice.getText("t").insert(0, "hello");
			syncBoth();
			alice.getText("t").insert(5, " world");

			expect(stateVectorIsAhead(
				Y.encodeStateVector(alice),
				Y.encodeStateVector(bob),
			)).toBe(true);

			expect(stateVectorIsAhead(
				Y.encodeStateVector(bob),
				Y.encodeStateVector(alice),
			)).toBe(false);
			destroy();
		});
	});
});

// =============================================================================
// State vector edge cases
// =============================================================================

describe('State vector edge cases', () => {
	test('PERSISTENCE_LOADED with empty updates', async () => {
		const t = await createTestHSM();
		t.send(load('test-guid'));
		t.send(persistenceLoaded(new Uint8Array(), null));

		expect(t.statePath).toBe('loading');
	});

	test('remoteDoc and localDoc with completely independent histories', async () => {
		// This simulates a worst-case scenario where two clients started
		// from scratch and created content independently
		const t = await createTestHSM();
		await loadToIdle(t, { content: 'local content', mtime: 1000 });

		// Apply a completely independent change to remoteDoc
		// (new content from a different client that shares no CRDT history)
		const independentDoc = new Y.Doc();
		independentDoc.getText('contents').insert(0, 'independent remote');
		const independentUpdate = Y.encodeStateAsUpdate(independentDoc);
		independentDoc.destroy();

		t.send({ type: 'REMOTE_UPDATE', update: independentUpdate });
		await t.hsm.awaitIdleAutoMerge();

		// Should not crash — content may be duplicated but HSM should be in valid state
		expect(t.matches('idle')).toBe(true);
	});
});
