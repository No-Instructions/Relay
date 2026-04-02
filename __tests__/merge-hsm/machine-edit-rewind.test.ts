/**
 * Tests for machine edit rewind — the mechanism that prevents duplicate CRDT
 * ops when both vaults independently run vault.process(file, fn).
 *
 * "OpCapture.cancel" tests verify the CRDT primitive: two Y.Docs apply the
 * same text transform independently, then the receiver cancels its local ops
 * and applies the remote version instead.
 *
 * "HSM integration" tests verify the full orchestration: registerMachineEdit →
 * CM6_CHANGE → REMOTE_UPDATE → rewind, TTL expiry, and editor deactivation.
 */

import * as Y from "yjs";
import { OpCapture } from "src/merge-hsm/undo/OpCapture";
import { DISK_ORIGIN, MACHINE_EDIT_ORIGIN } from "src/merge-hsm/undo/origins";
import type { CapturedOp } from "src/merge-hsm/undo/OpCapture";
import { diff_match_patch } from "diff-match-patch";
import {
	createTestHSM,
	loadAndActivate,
	cm6Change,
	releaseLock,
	expectState,
	expectEffect,
	expectNoEffect,
	expectLocalDocText,
	createLCA,
} from "src/merge-hsm/testing";
import type { TestHSM } from "src/merge-hsm/testing";
import { createCrossVaultTest } from "src/merge-hsm/testing/createCrossVaultTest";

// ===========================================================================
// Helpers — CRDT primitive tests
// ===========================================================================

function makeDoc(initialText = ""): { doc: Y.Doc; ytext: Y.Text } {
	const doc = new Y.Doc();
	const ytext = doc.getText("contents");
	if (initialText) {
		ytext.insert(0, initialText);
	}
	return { doc, ytext };
}

function applyDiffWithOrigin(
	doc: Y.Doc,
	ytext: Y.Text,
	newContent: string,
	origin: any,
): void {
	const currentText = ytext.toString();
	if (currentText === newContent) return;

	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(currentText, newContent);
	dmp.diff_cleanupSemantic(diffs);

	doc.transact(() => {
		let cursor = 0;
		for (const [op, text] of diffs) {
			switch (op) {
				case 1:
					ytext.insert(cursor, text);
					cursor += text.length;
					break;
				case 0:
					cursor += text.length;
					break;
				case -1:
					ytext.delete(cursor, text.length);
					break;
			}
		}
	}, origin);
}

/**
 * Cancel local machine-edit ops, merge remote CRDT, verify clean result.
 *
 * Uses cancel(): truly undoes the CRDT ops (deletes inserted items,
 * un-tombstones deleted items) so the remote update applies cleanly.
 */
function cancelAndMerge(
	localDoc: Y.Doc,
	localYText: Y.Text,
	remoteDoc: Y.Doc,
	opCapture: OpCapture,
	machineOps: CapturedOp[],
): void {
	opCapture.cancel(machineOps);

	const update = Y.encodeStateAsUpdate(
		remoteDoc,
		Y.encodeStateVector(localDoc),
	);
	Y.applyUpdate(localDoc, update, remoteDoc);
}

// ===========================================================================
// Helpers — HSM integration tests
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
 * CM6 represents a replace as a single {from, to, insert} — not separate
 * delete + insert like raw DMP output.
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
			i++; // skip next
		} else {
			merged.push(curr);
		}
	}
	return merged;
}

// ===========================================================================
// Tests — OpCapture.cancel
// ===========================================================================

describe("OpCapture.cancel", () => {
	it("reverse restores text to pre-edit state", () => {
		const { doc: localDoc, ytext: localYText } = makeDoc("Hello [[B]] world");
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([MACHINE_EDIT_ORIGIN]),
			captureTimeout: 0,
		});

		const mark = capture.mark();
		applyDiffWithOrigin(localDoc, localYText, "Hello [[C]] world", MACHINE_EDIT_ORIGIN);
		expect(localYText.toString()).toBe("Hello [[C]] world");

		const ops = capture.sinceByOrigin(mark, MACHINE_EDIT_ORIGIN);
		capture.reverse(ops);
		expect(localYText.toString()).toBe("Hello [[B]] world");
	});

	it("cancel + remote merge produces correct text (no duplication)", () => {
		const { doc: localDoc, ytext: localYText } = makeDoc("Hello [[B]] world");
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([MACHINE_EDIT_ORIGIN]),
			captureTimeout: 0,
		});

		const { doc: remoteDoc, ytext: remoteYText } = makeDoc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));

		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		const mark = capture.mark();
		applyDiffWithOrigin(localDoc, localYText, fn(localYText.toString()), MACHINE_EDIT_ORIGIN);
		applyDiffWithOrigin(remoteDoc, remoteYText, fn(remoteYText.toString()), remoteDoc);

		expect(fn(remoteYText.toString())).toBe(remoteYText.toString());

		const machineOps = capture.sinceByOrigin(mark, MACHINE_EDIT_ORIGIN);
		cancelAndMerge(localDoc, localYText, remoteDoc, capture, machineOps);

		expect(localYText.toString()).toBe("Hello [[C]] world");
	});

	it("multi-link replacement: no duplication after cancel + merge", () => {
		const { doc: localDoc, ytext: localYText } = makeDoc(
			"See [[A]], also [[B]] and [[A]] again",
		);
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([MACHINE_EDIT_ORIGIN]),
			captureTimeout: 0,
		});

		const { doc: remoteDoc, ytext: remoteYText } = makeDoc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));

		const fn = (text: string) => text.replaceAll("[[A]]", "[[A-renamed]]");

		const mark = capture.mark();
		applyDiffWithOrigin(localDoc, localYText, fn(localYText.toString()), MACHINE_EDIT_ORIGIN);
		applyDiffWithOrigin(remoteDoc, remoteYText, fn(remoteYText.toString()), remoteDoc);

		const machineOps = capture.sinceByOrigin(mark, MACHINE_EDIT_ORIGIN);
		cancelAndMerge(localDoc, localYText, remoteDoc, capture, machineOps);

		expect(localYText.toString()).toBe(
			"See [[A-renamed]], also [[B]] and [[A-renamed]] again",
		);
	});

	it("cancel undoes deletions: delete-only transform merges cleanly", () => {
		const { doc: localDoc, ytext: localYText } = makeDoc("Hello [[B]] world");
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([MACHINE_EDIT_ORIGIN]),
			captureTimeout: 0,
		});

		const { doc: remoteDoc } = makeDoc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));

		// Machine edit that deletes "[[B]] " entirely (no insertions)
		const mark = capture.mark();
		applyDiffWithOrigin(localDoc, localYText, "Hello world", MACHINE_EDIT_ORIGIN);
		expect(localYText.toString()).toBe("Hello world");

		// Cancel truly restores the deleted text (no ghost items)
		const ops = capture.sinceByOrigin(mark, MACHINE_EDIT_ORIGIN);
		capture.cancel(ops);
		expect(localYText.toString()).toBe("Hello [[B]] world");

		// Remote applies same deletion
		const remoteYText = remoteDoc.getText("contents");
		applyDiffWithOrigin(remoteDoc, remoteYText, "Hello world", remoteDoc);

		// Merge remote — remote's delete applies cleanly
		const update = Y.encodeStateAsUpdate(
			remoteDoc,
			Y.encodeStateVector(localDoc),
		);
		Y.applyUpdate(localDoc, update, remoteDoc);

		expect(localYText.toString()).toBe("Hello world");
	});

	it("fn no-op produces no OpCapture entries", () => {
		const { doc: localDoc, ytext: localYText } = makeDoc("Hello [[C]] world");
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([MACHINE_EDIT_ORIGIN]),
			captureTimeout: 0,
		});

		const fn = (text: string) => text.replace("[[B]]", "[[C]]");
		expect(fn(localYText.toString())).toBe(localYText.toString());

		const mark = capture.mark();
		applyDiffWithOrigin(localDoc, localYText, fn(localYText.toString()), MACHINE_EDIT_ORIGIN);
		expect(capture.sinceByOrigin(mark, MACHINE_EDIT_ORIGIN).length).toBe(0);
	});

	it("cancel throws if ops have been synced", () => {
		const { doc: localDoc, ytext: localYText } = makeDoc("Hello [[B]] world");
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([MACHINE_EDIT_ORIGIN]),
			captureTimeout: 0,
		});

		const mark = capture.mark();
		applyDiffWithOrigin(localDoc, localYText, "Hello [[C]] world", MACHINE_EDIT_ORIGIN);

		const ops = capture.sinceByOrigin(mark, MACHINE_EDIT_ORIGIN);
		expect(ops.length).toBeGreaterThan(0);

		capture.notifySynced();

		expect(() => capture.cancel(ops)).toThrow(/synced to remote/);
	});

	it("cancel succeeds on ops captured after notifySynced", () => {
		const { doc: localDoc, ytext: localYText } = makeDoc("Hello [[B]] world");
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([MACHINE_EDIT_ORIGIN]),
			captureTimeout: 0,
		});

		// First edit — gets synced
		applyDiffWithOrigin(localDoc, localYText, "Hello [[C]] world", MACHINE_EDIT_ORIGIN);
		capture.notifySynced();

		// Second edit — captured after sync, not yet synced
		const mark = capture.mark();
		applyDiffWithOrigin(localDoc, localYText, "Hello [[D]] world", MACHINE_EDIT_ORIGIN);

		const ops = capture.sinceByOrigin(mark, MACHINE_EDIT_ORIGIN);
		expect(ops.length).toBeGreaterThan(0);
		expect(() => capture.cancel(ops)).not.toThrow();
	});

	it("sinceByOrigin returns empty when no ops captured", () => {
		const { ytext: localYText } = makeDoc("Hello [[B]] world");
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([MACHINE_EDIT_ORIGIN]),
			captureTimeout: 0,
		});

		const mark = capture.mark();
		expect(capture.sinceByOrigin(mark, MACHINE_EDIT_ORIGIN).length).toBe(0);
	});

	it("editor ops survive disk op cancellation (anchored to CRDT positions)", () => {
		// Spec scenario: disk ingest adds content, user types on top of it,
		// then disk ops are cancelled during fork reconciliation. User's edits
		// must survive because they are anchored to neighbouring CRDT items,
		// not absolute byte offsets.
		const { doc: localDoc, ytext: localYText } = makeDoc("Hello");
		const capture = new OpCapture(localYText, {
			trackedOrigins: new Set([DISK_ORIGIN]),
			captureTimeout: 0,
		});

		// Disk ingest: "Hello" → "Hello World" (adds " World")
		const mark = capture.mark();
		applyDiffWithOrigin(localDoc, localYText, "Hello World", DISK_ORIGIN);
		expect(localYText.toString()).toBe("Hello World");

		// User types "!" at the end (no tracked origin — editor keystrokes)
		localDoc.transact(() => {
			localYText.insert(localYText.toString().length, "!");
		});
		expect(localYText.toString()).toBe("Hello World!");

		// Cancel disk ops — " World" is tombstoned, "!" stays anchored
		const diskOps = capture.sinceByOrigin(mark, DISK_ORIGIN);
		expect(diskOps.length).toBeGreaterThan(0);
		capture.cancel(diskOps);

		expect(localYText.toString()).toBe("Hello!");
	});
});

// ===========================================================================
// Tests — HSM integration
// ===========================================================================

describe("machine edit rewind - HSM integration", () => {
	it("rewinds local ops when matching remote ops arrive", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		// 1. Register machine edit
		t.hsm.registerMachineEdit(fn);

		// 2. CM6_CHANGE (Obsidian's loadFileInternal after vault.process)
		const changes = computeCM6Changes("Hello [[B]] world", "Hello [[C]] world");
		t.send(cm6Change(changes, "Hello [[C]] world"));

		expectLocalDocText(t, "Hello [[C]] world");

		// No SYNC_TO_REMOTE — deferred
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");

		// 3. Remote applies same transform
		t.applyRemoteChange("Hello [[C]] world");

		// After rewind, no duplication
		expectLocalDocText(t, "Hello [[C]] world");

		// Deferred outbound entries discarded — the only SYNC_TO_REMOTE
		// is the SV metadata sync (cancel ops clock advancement), not the
		// machine edit content itself.
		const syncEffects = t.effects.filter(e => e.type === "SYNC_TO_REMOTE");
		expect(syncEffects.length).toBeLessThanOrEqual(1);
	});

	it("syncs ops on TTL expiry (originator vault)", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);
		const changes = computeCM6Changes("Hello [[B]] world", "Hello [[C]] world");
		t.send(cm6Change(changes, "Hello [[C]] world"));

		expectLocalDocText(t, "Hello [[C]] world");
		expectNoEffect(t.effects, "SYNC_TO_REMOTE");

		// Advance time past TTL (5s + 100ms)
		t.time.setTime(t.time.now() + 5200);

		// After expiry, ops are synced
		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
		expectLocalDocText(t, "Hello [[C]] world");
	});

	it("skips registration when fn is a no-op", async () => {
		const t = await setupActive("Hello [[C]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		// fn doesn't change text (no [[B]] to replace) → no registration
		t.hsm.registerMachineEdit(fn);

		// Normal edit syncs immediately
		t.send(cm6Change(
			[{ from: 17, to: 17, insert: "!" }],
			"Hello [[C]] world!",
		));

		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
	});

	it("flushes pending machine edits on deactivation", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);
		const changes = computeCM6Changes("Hello [[B]] world", "Hello [[C]] world");
		t.send(cm6Change(changes, "Hello [[C]] world"));

		expectNoEffect(t.effects, "SYNC_TO_REMOTE");

		// Release lock → deactivateEditor flushes pending edits
		t.send(releaseLock());
		await t.hsm.awaitCleanup();

		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
	});

	it("remote arrives before vault.process — no rewind needed", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		// Remote applies transform first
		t.applyRemoteChange("Hello [[C]] world");
		expectLocalDocText(t, "Hello [[C]] world");

		// vault.process fires — fn(localDocText) === localDocText → no registration
		t.hsm.registerMachineEdit(fn);

		expectLocalDocText(t, "Hello [[C]] world");
	});

	it("normal user edits sync immediately during machine edit window", async () => {
		const t = await setupActive("Hello [[B]] world");
		const fn = (text: string) => text.replace("[[B]]", "[[C]]");

		t.hsm.registerMachineEdit(fn);

		// User types something different (not matching expectedText)
		t.send(cm6Change(
			[{ from: 17, to: 17, insert: "!!!" }],
			"Hello [[B]] world!!!",
		));

		// Syncs immediately — docText doesn't match expectedText
		expectEffect(t.effects, { type: "SYNC_TO_REMOTE" });
	});
});

// ===========================================================================
// Machine edit: source active on A, idle on B
// ===========================================================================

async function setupVariant2(content: string) {
  const ctx = await createCrossVaultTest();

  await loadAndActivate(ctx.vaultA.hsm, content);
  ctx.vaultA.disk.content = content;
  ctx.vaultA.disk.mtime = Date.now();

  const localDocA = ctx.vaultA.hsm.hsm.getLocalDoc()!;
  const canonicalUpdate = Y.encodeStateAsUpdate(localDocA);
  Y.applyUpdate(ctx.server, canonicalUpdate, 'vaultA');

  ctx.vaultB.hsm.seedIndexedDB(canonicalUpdate);
  ctx.vaultB.hsm.syncRemoteWithUpdate(canonicalUpdate);

  const mtime = Date.now();
  const stateVector = Y.encodeStateVectorFromUpdate(canonicalUpdate);
  const lca = await createLCA(content, mtime, stateVector);

  ctx.vaultB.send({ type: 'LOAD', guid: 'cross-vault-doc' });
  ctx.vaultB.send({ type: 'PERSISTENCE_LOADED', updates: canonicalUpdate, lca });
  ctx.vaultB.send({ type: 'SET_MODE_IDLE' });
  ctx.vaultB.hsm.setProviderSynced?.(true);

  await ctx.vaultB.hsm.hsm.awaitState?.((s: string) => s === 'idle.synced');
  ctx.vaultB.disk.content = content;
  ctx.vaultB.disk.mtime = mtime;

  expect(ctx.vaultA.hsm.statePath).toBe('active.tracking');
  expect(ctx.vaultB.hsm.statePath).toBe('idle.synced');

  ctx.vaultA.clearEffects();
  ctx.vaultB.clearEffects();

  return ctx;
}

describe('Machine edit: source active on A, idle on B', () => {
  test('disk edit on B first, then A CRDT arrives = no duplication', async () => {
    const content = 'Source file.\nLink: [[target]]\nEnd of file.';
    const renamed = 'Source file.\nLink: [[renamed]]\nEnd of file.';
    const ctx = await setupVariant2(content);

    // Vault A: machine edit
    ctx.vaultA.editText(renamed);

    // Vault B: vault.process() writes to disk (before A's CRDT arrives)
    await ctx.vaultB.writeFile(renamed);

    // Wait for fork reconcile on B (A's CRDT not on server yet)
    await new Promise(r => setTimeout(r, 200));

    console.log('[Phase 1] B state:', ctx.vaultB.hsm.statePath);
    console.log('[Phase 1] B localDoc:', JSON.stringify(ctx.vaultB.getLocalText()));

    // Now sync A's CRDT to server, then deliver to B
    ctx.sync();

    // Wait for B to process the REMOTE_UPDATE
    await new Promise(r => setTimeout(r, 200));

    const bText = ctx.vaultB.getLocalText();
    const bDisk = ctx.vaultB.disk.content;

    console.log('[Phase 2] B state:', ctx.vaultB.hsm.statePath);
    console.log('[Phase 2] B localDoc:', JSON.stringify(bText));
    console.log('[Phase 2] B disk:', JSON.stringify(bDisk));

    expect(bText).toBe(renamed);
    expect(bText).not.toContain('renamedrenamed');
    expect(bDisk).toBe(renamed);
    expect(bDisk).not.toContain('renamedrenamed');

    ctx.destroy();
  });

  test('A CRDT arrives at B first (idle sync), then disk unchanged = correct', async () => {
    const content = 'Source file.\nLink: [[target]]\nEnd of file.';
    const renamed = 'Source file.\nLink: [[renamed]]\nEnd of file.';
    const ctx = await setupVariant2(content);

    // Vault A: machine edit
    ctx.vaultA.editText(renamed);

    // Sync A's CRDT to server and deliver to B as REMOTE_UPDATE
    ctx.sync();

    // Wait for idle-merge on B
    await new Promise(r => setTimeout(r, 200));

    const bText = ctx.vaultB.getLocalText();
    const bDisk = ctx.vaultB.disk.content;

    console.log('[Scenario 2] B state:', ctx.vaultB.hsm.statePath);
    console.log('[Scenario 2] B localDoc:', JSON.stringify(bText));
    console.log('[Scenario 2] B disk:', JSON.stringify(bDisk));

    expect(bText).toBe(renamed);
    expect(bDisk).toBe(renamed);
    expect(bText).not.toContain('renamedrenamed');

    ctx.destroy();
  });

  test('A CRDT and B disk edit arrive simultaneously = no duplication', async () => {
    const content = 'Source file.\nLink: [[target]]\nEnd of file.';
    const renamed = 'Source file.\nLink: [[renamed]]\nEnd of file.';
    const ctx = await setupVariant2(content);

    // Vault A: machine edit
    ctx.vaultA.editText(renamed);

    // Both happen "simultaneously": B writes disk AND A's CRDT arrives
    await ctx.vaultB.writeFile(renamed);
    ctx.sync();  // A's CRDT arrives at B

    // Wait for merge
    await new Promise(r => setTimeout(r, 500));

    const bText = ctx.vaultB.getLocalText();
    const bDisk = ctx.vaultB.disk.content;

    console.log('[Scenario 3] B state:', ctx.vaultB.hsm.statePath);
    console.log('[Scenario 3] B localDoc:', JSON.stringify(bText));
    console.log('[Scenario 3] B disk:', JSON.stringify(bDisk));

    expect(bText).toBe(renamed);
    expect(bDisk).toBe(renamed);
    expect(bText).not.toContain('renamedrenamed');

    ctx.destroy();
  });
});

// ===========================================================================
// Machine edit: both vaults active
// ===========================================================================

async function bootBothVaultsActive(content: string) {
  const ctx = await createCrossVaultTest();

  await loadAndActivate(ctx.vaultA.hsm, content);
  ctx.vaultA.disk.content = content;
  ctx.vaultA.disk.mtime = Date.now();

  const localDocA = ctx.vaultA.hsm.hsm.getLocalDoc()!;
  const canonicalUpdate = Y.encodeStateAsUpdate(localDocA);
  Y.applyUpdate(ctx.server, canonicalUpdate, 'vaultA');

  if (content) {
    ctx.vaultB.hsm.seedIndexedDB(canonicalUpdate);
    ctx.vaultB.hsm.syncRemoteWithUpdate(canonicalUpdate);
  }

  const mtime = Date.now();
  const stateVector = content ? Y.encodeStateVectorFromUpdate(canonicalUpdate) : new Uint8Array([0]);
  const lca = await createLCA(content, mtime, stateVector);
  const updates = content ? canonicalUpdate : new Uint8Array();

  ctx.vaultB.send({ type: 'LOAD', guid: 'cross-vault-doc' });
  ctx.vaultB.send({ type: 'PERSISTENCE_LOADED', updates, lca });
  ctx.vaultB.send({ type: 'SET_MODE_ACTIVE' });
  ctx.vaultB.send({ type: 'ACQUIRE_LOCK', editorContent: content });

  await ctx.vaultB.hsm.hsm.awaitState?.((s: string) => s === 'active.tracking');
  ctx.vaultB.disk.content = content;
  ctx.vaultB.disk.mtime = mtime;

  ctx.sync();
  ctx.vaultA.clearEffects();
  ctx.vaultB.clearEffects();

  return ctx;
}

describe('Machine edit: both vaults active', () => {
  test('REMOTE_UPDATE produces DISPATCH_CM6 on vault B', async () => {
    const content = 'Source file.\nLink: [[target]]\nEnd of file.';
    const ctx = await bootBothVaultsActive(content);

    // Vault A edits (wikilink rename)
    ctx.vaultA.editText('Source file.\nLink: [[renamed]]\nEnd of file.');

    // Sync through server
    ctx.sync();

    const dispatchEffects = ctx.vaultB.effects.filter(e => e.type === 'DISPATCH_CM6');
    expect(ctx.vaultB.getLocalText()).toBe('Source file.\nLink: [[renamed]]\nEnd of file.');
    expect(dispatchEffects.length).toBeGreaterThan(0);

    ctx.destroy();
  });

  test('REMOTE_UPDATE during active.entering is accumulated and applied on tracking entry', async () => {
    const content = 'Source file.\nLink: [[target]]\nEnd of file.';
    const ctx = await createCrossVaultTest();

    // Boot vault A and make the edit
    await loadAndActivate(ctx.vaultA.hsm, content);
    ctx.vaultA.disk.content = content;
    ctx.vaultA.disk.mtime = Date.now();

    const localDocA = ctx.vaultA.hsm.hsm.getLocalDoc()!;
    const canonicalUpdate = Y.encodeStateAsUpdate(localDocA);
    Y.applyUpdate(ctx.server, canonicalUpdate, 'vaultA');

    ctx.vaultA.editText('Source file.\nLink: [[renamed]]\nEnd of file.');
    ctx.sync(); // A -> server

    // Boot vault B with OLD IDB content (simulates re-acquire-lock)
    ctx.vaultB.hsm.seedIndexedDB(canonicalUpdate);
    ctx.vaultB.hsm.syncRemoteWithUpdate(canonicalUpdate);

    const mtime = Date.now();
    const stateVector = Y.encodeStateVectorFromUpdate(canonicalUpdate);
    const lca = await createLCA(content, mtime, stateVector);

    ctx.vaultB.send({ type: 'LOAD', guid: 'cross-vault-doc' });
    ctx.vaultB.send({ type: 'PERSISTENCE_LOADED', updates: canonicalUpdate, lca });
    ctx.vaultB.send({ type: 'SET_MODE_ACTIVE' });
    ctx.vaultB.send({ type: 'ACQUIRE_LOCK', editorContent: content });

    // Deliver vault A's update to B's remoteDoc and HSM during entering phase
    const remoteDocB = ctx.vaultB.hsm.hsm.getRemoteDoc()!;
    const updateForB = Y.encodeStateAsUpdate(ctx.server, Y.encodeStateVector(remoteDocB));
    if (updateForB.length > 0) {
      Y.applyUpdate(remoteDocB, updateForB, 'provider');
      ctx.vaultB.send({ type: 'REMOTE_UPDATE', update: updateForB });
    }

    await ctx.vaultB.hsm.hsm.awaitState?.((s: string) => s === 'active.tracking');

    // Vault B should have the renamed link after entering tracking
    expect(ctx.vaultB.getLocalText()).toBe('Source file.\nLink: [[renamed]]\nEnd of file.');

    ctx.destroy();
  });
});
