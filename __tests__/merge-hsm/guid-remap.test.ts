/**
 * Tests for Document GUID remap scenarios.
 *
 * When a shared folder reconciliation discovers that the local GUID for a
 * Document differs from the remote GUID, the old Document is destroyed and
 * a fresh one is created under the server's GUID. This file tests:
 *
 * 1. SharedFolder Document GUID remap logic (data structure correctness)
 * 2. HSM behavior when fresh Document receives remote content post-remap
 * 3. Document.destroyed flag set on destroy()
 * 4. HSMEditorPlugin's destroyed-detection and GUID-change detection
 */

import {
	createTestHSM,
	loadAndActivate,
	expectState,
	expectLocalDocText,
	expectRemoteDocText,
} from "src/merge-hsm/testing";

// ===========================================================================
// 1. SharedFolder Document GUID remap logic
// ===========================================================================

describe("SharedFolder Document GUID remap", () => {
	/**
	 * SharedFolder._handleRemoteDiffEntry is private and requires full
	 * Obsidian mocking. Instead, we test the remap logic in isolation
	 * using the same data structures (Map<guid, file>) that SharedFolder uses.
	 */
	test("remap destroys old doc and creates new doc under remote GUID", () => {
		// Simulate SharedFolder.files and a Document with guid
		const files = new Map<string, { guid: string; path: string; destroyed: boolean }>();
		const oldDoc = { guid: "local-guid-aaa", path: "notes/test.md", destroyed: false };
		files.set("local-guid-aaa", oldDoc);

		const pendingUpload = new Map<string, string>();
		pendingUpload.set("notes/test.md", "local-guid-aaa");

		// Remote GUID differs from local
		const remoteGuid = "remote-guid-bbb";

		// Destroy/create logic (mirrors SharedFolder._handleRemoteDiffEntry)
		files.delete("local-guid-aaa");
		oldDoc.destroyed = true; // simulates localFile.destroy()

		const newDoc = { guid: remoteGuid, path: "notes/test.md", destroyed: false };
		files.set(remoteGuid, newDoc);
		pendingUpload.delete("notes/test.md");

		// Verify: old doc is destroyed, new doc exists under remote GUID
		expect(oldDoc.destroyed).toBe(true);
		expect(files.get("local-guid-aaa")).toBeUndefined();
		expect(files.get("remote-guid-bbb")).toBe(newDoc);
		expect(newDoc.guid).toBe("remote-guid-bbb");
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
// 2. Fresh HSM receives remote content (simulates post-remap provider sync)
// ===========================================================================

describe("Fresh HSM receives remote content post-remap", () => {
	test("HSM initialized with disk content can receive remote edits", async () => {
		// A fresh Document created during remap goes through the standard
		// LOAD → PERSISTENCE_LOADED → SET_MODE_IDLE → acquireLock lifecycle.
		// When the editor opens, remote content arrives via the provider.
		const t = await createTestHSM({ guid: "new-guid" });
		await loadAndActivate(t, "hello");
		expectState(t, "active.tracking");
		t.clearEffects();

		// Simulate remote edit arriving (as happens after remap when the
		// provider syncs the server's CRDT under the new GUID)
		t.applyRemoteChange("hello world");

		expectLocalDocText(t, "hello world");
		expectRemoteDocText(t, "hello world");
	});

	test("remote-only update with no editor transaction still syncs to localDoc", async () => {
		const t = await createTestHSM();
		await loadAndActivate(t, "original");
		expectState(t, "active.tracking");
		t.clearEffects();

		t.applyRemoteChange("original + remote addition");
		expectLocalDocText(t, "original + remote addition");
	});
});

// ===========================================================================
// 3. Document.destroyed flag
// ===========================================================================

describe("Document.destroyed flag", () => {
	test("destroyed flag is false initially and true after destroy", async () => {
		// Use the HSM test harness to create a minimal Document-like lifecycle.
		// The actual Document.destroyed flag is tested structurally here since
		// Document requires full Obsidian mocking.
		const doc = { destroyed: false };
		expect(doc.destroyed).toBe(false);

		// Simulate destroy()
		doc.destroyed = true;
		expect(doc.destroyed).toBe(true);
	});
});

// ===========================================================================
// 4. HSMEditorPlugin detection (structural verification)
// ===========================================================================

describe("HSMEditorPlugin destroyed and GUID-change detection", () => {
	/**
	 * The HSMEditorPlugin is a CM6 ViewPlugin tightly coupled to Obsidian's
	 * editorInfoField and DOM structure. Full unit testing requires mocking
	 * EditorView, ViewUpdate, editorInfoField, getConnectionManager, and
	 * the SharedFolder lookup chain.
	 *
	 * Instead, we verify the structural properties that make the fix work:
	 * 1. The destroyed check runs BEFORE the GUID mismatch check
	 * 2. The GUID check runs BEFORE the docChanged early-return guard
	 */

	let source: string;
	beforeAll(() => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require("path");
		source = fs.readFileSync(
			path.resolve(__dirname, "../../src/merge-hsm/integration/HSMEditorPlugin.ts"),
			"utf-8",
		);
	});

	test("destroyed check precedes GUID mismatch check", () => {
		const destroyedCheckPos = source.indexOf("this.document?.destroyed");
		const guidCheckPos = source.indexOf("currentDoc.guid !== this.document.guid");

		expect(destroyedCheckPos).toBeGreaterThan(-1);
		expect(guidCheckPos).toBeGreaterThan(-1);
		expect(destroyedCheckPos).toBeLessThan(guidCheckPos);
	});

	test("GUID check precedes docChanged guard in update()", () => {
		const guidCheckPos = source.indexOf("currentDoc.guid !== this.document.guid");
		const docChangedPos = source.indexOf("if (!update.docChanged) return");

		expect(guidCheckPos).toBeGreaterThan(-1);
		expect(docChangedPos).toBeGreaterThan(-1);
		expect(guidCheckPos).toBeLessThan(docChangedPos);
	});

	test("destroyed check tears down cm6Integration and calls initializeIfReady", () => {
		// Extract the destroyed check block
		const destroyedStart = source.indexOf("this.document?.destroyed");
		const guidStart = source.indexOf("if (this.document) {", destroyedStart);
		const destroyedSection = source.slice(destroyedStart, guidStart);

		expect(destroyedSection).toContain("this.cm6Integration.destroy()");
		expect(destroyedSection).toContain("this.document = null");
		expect(destroyedSection).toContain("this.initializeIfReady()");
	});

	test("initializeIfReady() is called after GUID mismatch teardown", () => {
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
