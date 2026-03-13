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
import { OpCapture } from "../undo/OpCapture";
import { MACHINE_EDIT_ORIGIN } from "../undo/origins";
import type { CapturedOp } from "../undo/OpCapture";
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
} from "../testing";
import type { TestHSM } from "../testing";

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
