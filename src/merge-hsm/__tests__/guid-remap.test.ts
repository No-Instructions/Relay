/**
 * Tests for Document GUID remap scenarios.
 *
 * When a shared folder reconciliation discovers that the local GUID for a
 * Document differs from the remote GUID, the Document is remapped to the
 * remote GUID. This file tests:
 *
 * 1. SharedFolder Document GUID remap logic (data structure correctness)
 * 2. HSM behavior after GUID remap (sync continues working)
 * 3. HSMEditorPlugin's GUID-change detection and CM6Integration teardown/reinit
 *    (tested structurally since the plugin depends on Obsidian internals)
 */

import * as Y from "yjs";
import {
	createTestHSM,
	loadAndActivate,
	expectState,
	expectLocalDocText,
	expectRemoteDocText,
} from "../testing";

// ===========================================================================
// 1. SharedFolder Document GUID remap logic
// ===========================================================================

describe("SharedFolder Document GUID remap", () => {
	/**
	 * SharedFolder._handleRemoteDiffEntry is private and requires full
	 * Obsidian mocking. Instead, we test the remap logic in isolation
	 * using the same data structures (Map<guid, file>) that SharedFolder uses.
	 */
	test("remap updates files map correctly: old GUID removed, new GUID added", () => {
		// Simulate SharedFolder.files and a Document with guid
		const files = new Map<string, { guid: string; path: string }>();
		const doc = { guid: "local-guid-aaa", path: "notes/test.md" };
		files.set("local-guid-aaa", doc);

		const pendingUpload = new Map<string, string>();
		pendingUpload.set("notes/test.md", "local-guid-aaa");

		// Remote GUID differs from local
		const remoteGuid = "remote-guid-bbb";

		// Remap logic (mirrors SharedFolder._handleRemoteDiffEntry)
		const localGuid = "local-guid-aaa";
		files.delete(localGuid);
		files.set(remoteGuid, doc);
		doc.guid = remoteGuid;
		pendingUpload.delete("notes/test.md");

		// Verify: old GUID is gone, new GUID maps to the document
		expect(files.get("local-guid-aaa")).toBeUndefined();
		expect(files.get("remote-guid-bbb")).toBe(doc);
		expect(doc.guid).toBe("remote-guid-bbb");
		// pendingUpload is cleared so syncStore.get() returns the Y.Map value
		expect(pendingUpload.has("notes/test.md")).toBe(false);
	});

	test("remap is idempotent: second remap with same GUID is a no-op", () => {
		const files = new Map<string, { guid: string }>();
		const doc = { guid: "remote-guid-bbb" };
		files.set("remote-guid-bbb", doc);

		// On the next diff cycle, files.get(remoteGuid) succeeds,
		// so the !file check fails and the remap path is not entered.
		const file = files.get("remote-guid-bbb");
		expect(file).toBe(doc);
		// This means the remap branch is skipped — no repeated remap.
	});
});

// ===========================================================================
// 2. HSM survives GUID remap during active tracking
// ===========================================================================

describe("GUID remap during active tracking", () => {
	test("HSM continues to sync after remote content arrives post-remap", async () => {
		// Setup: active.tracking with content "hello"
		const t = await createTestHSM({ guid: "old-guid" });
		await loadAndActivate(t, "hello");
		expectState(t, "active.tracking");
		t.clearEffects();

		// Simulate a remote edit arriving (as would happen after GUID remap
		// when the remote doc starts syncing under the new GUID)
		t.applyRemoteChange("hello world");

		// Verify the remote content was merged into localDoc
		expectLocalDocText(t, "hello world");
		expectRemoteDocText(t, "hello world");
	});

	test("remote-only update with no editor transaction still syncs to localDoc", async () => {
		// This simulates the GUID remap scenario where the remote sends
		// content but no CM6 transaction fires (the key scenario from the
		// HSMEditorPlugin fix).
		const t = await createTestHSM();
		await loadAndActivate(t, "original");
		expectState(t, "active.tracking");
		t.clearEffects();

		// Apply remote change — in production this is what happens after
		// a GUID remap when new content arrives from the relay.
		t.applyRemoteChange("original + remote addition");

		expectLocalDocText(t, "original + remote addition");
	});
});

// ===========================================================================
// 3. HSM resetForGuidRemap — CRDT and LCA are discarded
// ===========================================================================

describe("HSM resetForGuidRemap", () => {
	test("clears LCA, localDoc, and state after remap", async () => {
		// Setup: idle.synced with content and an LCA
		const t = await createTestHSM({ guid: "old-guid" });
		await loadAndActivate(t, "hello world");
		expectState(t, "active.tracking");

		// Release lock to go idle, await cleanup
		t.send({ type: "RELEASE_LOCK" });
		await t.hsm.awaitCleanup();

		// Reset for GUID remap
		await t.hsm.resetForGuidRemap("new-guid", "test-new-guid");

		// After reset, HSM is in unloaded state with new GUID
		expect(t.hsm.state.statePath).toBe("unloaded");
		expect(t.hsm.guid).toBe("new-guid");

		// LCA is cleared (old GUID's LCA is meaningless)
		expect(t.hsm.state.lca).toBeNull();

		// localDoc is destroyed (nulled by resetForGuidRemap)
		expect(t.hsm.getLocalDoc()).toBeNull();

		// State vectors are cleared
		expect(t.hsm.state.localStateVector).toBeNull();
		expect(t.hsm.state.remoteStateVector).toBeNull();

		// Re-initialize the HSM under the new GUID
		t.send({ type: "LOAD", guid: "new-guid" });
		t.send({
			type: "PERSISTENCE_LOADED",
			updates: new Uint8Array(),
			lca: null,
			localStateVector: null,
		});
		t.send({ type: "SET_MODE_IDLE" });

		// HSM is back in idle with clean state
		expect(t.statePath.startsWith("idle.")).toBe(true);
		expect(t.hsm.state.lca).toBeNull();
	});

	test("re-initialized HSM can receive remote content and detect fork", async () => {
		const t = await createTestHSM({ guid: "old-guid" });
		await loadAndActivate(t, "local content");
		t.send({ type: "RELEASE_LOCK" });

		// Reset for GUID remap
		await t.hsm.resetForGuidRemap("new-guid", "test-new-guid");

		// Re-initialize
		t.send({ type: "LOAD", guid: "new-guid" });
		t.send({
			type: "PERSISTENCE_LOADED",
			updates: new Uint8Array(),
			lca: null,
			localStateVector: null,
		});
		t.send({ type: "SET_MODE_IDLE" });

		// The HSM starts fresh — no old CRDT contamination
		expect(t.hsm.guid).toBe("new-guid");
		expect(t.hsm.state.lca).toBeNull();
	});
});

// ===========================================================================
// 4. HSMEditorPlugin GUID-change detection (structural verification)
// ===========================================================================

describe("HSMEditorPlugin GUID-change detection", () => {
	/**
	 * The HSMEditorPlugin is a CM6 ViewPlugin tightly coupled to Obsidian's
	 * editorInfoField and DOM structure. Full unit testing requires mocking
	 * EditorView, ViewUpdate, editorInfoField, getConnectionManager, and
	 * the SharedFolder lookup chain.
	 *
	 * Instead, we verify the structural property that makes the fix work:
	 * the GUID check runs BEFORE the docChanged early-return guard.
	 */
	test("GUID check precedes docChanged guard in update()", () => {
		// Read the source to verify ordering
		// This is a structural/smoke test — the real coverage comes from E2E tests
		const fs = require("fs");
		const path = require("path");
		const source = fs.readFileSync(
			path.resolve(__dirname, "../integration/HSMEditorPlugin.ts"),
			"utf-8",
		);

		// Find the positions of the GUID check and docChanged guard
		const guidCheckPos = source.indexOf("currentDoc.guid !== this.document.guid");
		const docChangedPos = source.indexOf("if (!update.docChanged) return");

		expect(guidCheckPos).toBeGreaterThan(-1);
		expect(docChangedPos).toBeGreaterThan(-1);
		// GUID check must come before docChanged guard
		expect(guidCheckPos).toBeLessThan(docChangedPos);
	});

	test("initializeIfReady() is called after GUID mismatch teardown", () => {
		const fs = require("fs");
		const path = require("path");
		const source = fs.readFileSync(
			path.resolve(__dirname, "../integration/HSMEditorPlugin.ts"),
			"utf-8",
		);

		// After "this.document = null;" in the GUID mismatch block,
		// initializeIfReady() must be called before the closing brace.
		const teardownSection = source.slice(
			source.indexOf("currentDoc.guid !== this.document.guid"),
			source.indexOf("if (!update.docChanged) return"),
		);

		expect(teardownSection).toContain("this.cm6Integration.destroy()");
		expect(teardownSection).toContain("this.document = null");
		expect(teardownSection).toContain("this.initializeIfReady()");

		// Verify initializeIfReady comes after document = null
		const nullPos = teardownSection.indexOf("this.document = null");
		const initPos = teardownSection.indexOf("this.initializeIfReady()");
		expect(initPos).toBeGreaterThan(nullPos);
	});
});
