/**
 * Scenario visualizer for fork reconciliation.
 *
 * Generates a self-contained HTML file with:
 *   - Alice (editor + disk), Bob (editor + disk), Server panes
 *   - A scrubber to step through time
 *   - Character-level diff highlighting pre-computed at generation time
 *
 * Run: node_modules/.bin/esbuild unit/viz.ts --bundle --platform=node --outfile=/tmp/viz.cjs --format=cjs --define:__dirname='"unit"' && node /tmp/viz.cjs
 * Output: unit/disk-ingestion-viz.html
 */

import * as Y from "yjs";
// @ts-ignore
import { diff3Merge } from "node-diff3";
import { diff_match_patch } from "diff-match-patch";
import { writeFileSync } from "fs";
import { join } from "path";
import { OpCapture, CapturedOp, DISK_ORIGIN } from "../src/merge-hsm/undo/index";

// ─────────────────────────────────────────────────────────────
// Peer
// ─────────────────────────────────────────────────────────────

interface Fork { base: string; localSV: Uint8Array; remoteSV: Uint8Array; }

export interface DiskOpFate {
	/** Text of the doc before this disk op was applied. */
	before: string;
	/** Text of the doc after this disk op was applied. */
	after: string;
	/** "reversed" = redundant op dropped from the capture log (remote already has this change). Null = novel op, just flows normally. */
	fate: "reversed" | null;
}

export interface ReconcileDetail {
	diff3Local: string;
	diff3Base: string;
	diff3Remote: string;
	diff3Result: string | null;
	/** localDoc text after reversing redundant disk ops (before applying merge delta). */
	afterUndo: string;
	/** Per-op partition outcome, one entry per ingestDisk call. */
	diskOpFates: DiskOpFate[];
	/** How many disk ops were reversed (covered by remote) vs dropped (unique to local). */
	redundantCount: number;
	uniqueCount: number;
	/** True if non-disk editor ops exist that would survive full disk op reversal. */
	editorOpSurvived: boolean;
}

/**
 * Returns true if all text changes the disk op made (beforeText → afterText)
 * are already present in remoteText. Uses newline-as-explicit-token comparison.
 */
function isRedundantWithRemote(beforeText: string, afterText: string, remoteText: string): boolean {
	const tok = (s: string) => s.split(/(\n)/);
	const before = tok(beforeText), after = tok(afterText), remote = tok(remoteText);
	const len = Math.max(before.length, after.length);
	for (let i = 0; i < len; i++) {
		const b = before[i] ?? "", a = after[i] ?? "", r = remote[i] ?? "";
		if (a !== b && a !== r) return false;
	}
	return true;
}

class Peer {
	readonly localDoc: Y.Doc;
	readonly remoteDoc: Y.Doc;
	readonly opCapture: OpCapture;
	lca: string;
	fork: Fork | null = null;
	forkMark: number | null = null;
	lastReconcileDetail?: ReconcileDetail;
	online = true;
	private ingestionTexts: string[] = [];

	constructor() {
		this.localDoc = new Y.Doc();
		this.remoteDoc = new Y.Doc();
		this.lca = "";
		this.opCapture = new OpCapture(
			this.localDoc.getText("contents"),
			{ trackedOrigins: new Set([DISK_ORIGIN]), captureTimeout: 0 }
		);
	}

	get text() { return this.localDoc.getText("contents").toString(); }
	get remoteText() { return this.remoteDoc.getText("contents").toString(); }

	get diskOpCount() { return this.opCapture.sinceByOrigin(this.forkMark ?? 0, DISK_ORIGIN).length; }

	goOnline() { this.online = true; }
	goOffline() { this.online = false; }

	ingestDisk(t: string) {
		if (!this.fork) {
			this.fork = { base: this.text, localSV: Y.encodeStateVector(this.localDoc), remoteSV: Y.encodeStateVector(this.remoteDoc) };
			this.forkMark = this.opCapture.mark();
		}
		this.ingestionTexts.push(t);
		applyText(this.localDoc, t, DISK_ORIGIN);
	}

	typeInEditor(t: string) { applyText(this.localDoc, t); }

	receiveRemote(u: Uint8Array) { Y.applyUpdate(this.remoteDoc, u); }

	/** True if any non-disk editor ops changed the text beyond what disk ops produced. */
	get hasEditorOps(): boolean {
		if (!this.fork) return false;
		const lastDiskText = this.ingestionTexts.length > 0
			? this.ingestionTexts[this.ingestionTexts.length - 1]
			: this.fork.base;
		return this.text !== lastDiskText;
	}

	/** Compute partition (classify disk ops) without applying the merge. */
	computePartition(): ReconcileDetail {
		if (!this.fork) throw new Error("no fork");
		const { base } = this.fork;
		const loc = this.text, rem = this.remoteText;
		const tok = (s: string) => s.split(/(\n)/);
		const regions = diff3Merge(tok(loc), tok(base), tok(rem));
		if (regions.some((r: any) => "conflict" in r)) {
			this.lastReconcileDetail = { diff3Local: loc, diff3Base: base, diff3Remote: rem, diff3Result: null, afterUndo: loc, diskOpFates: [], redundantCount: 0, uniqueCount: 0, editorOpSurvived: this.hasEditorOps };
			return this.lastReconcileDetail;
		}
		const mergedTokens: string[] = [];
		for (const r of regions) { if ("ok" in r && r.ok) mergedTokens.push(...r.ok); }
		const diff3Result = mergedTokens.join("");

		// Partition disk ops: reverse those already covered by remote; drop unique ones.
		// Each ingestionTexts[i] is the "after" text for the i-th ingestDisk call.
		const diskOpFates: DiskOpFate[] = [];
		let redundantCount = 0, uniqueCount = 0;
		for (let i = 0; i < this.ingestionTexts.length; i++) {
			const beforeText = i === 0 ? base : this.ingestionTexts[i - 1];
			const afterText = this.ingestionTexts[i];
			if (isRedundantWithRemote(beforeText, afterText, rem)) {
				redundantCount++;
				diskOpFates.push({ before: beforeText, after: afterText, fate: "reversed" });
			} else {
				uniqueCount++;
				diskOpFates.push({ before: beforeText, after: afterText, fate: null });
			}
		}

		return { diff3Local: loc, diff3Base: base, diff3Remote: rem, diff3Result, afterUndo: loc, diskOpFates, redundantCount, uniqueCount, editorOpSurvived: this.hasEditorOps };
	}

	reconcile(): "synced" | "conflict" {
		if (!this.fork) throw new Error("no fork");
		const { base } = this.fork;
		const loc = this.text, rem = this.remoteText;
		const editorOpSurvived = this.hasEditorOps;
		const tok = (s: string) => s.split(/(\n)/);
		const regions = diff3Merge(tok(loc), tok(base), tok(rem));
		if (regions.some(r => "conflict" in r)) {
			this.lastReconcileDetail = { diff3Local: loc, diff3Base: base, diff3Remote: rem, diff3Result: null, afterUndo: loc, diskOpFates: [], redundantCount: 0, uniqueCount: 0, editorOpSurvived };
			return "conflict";
		}
		const tokens: string[] = [];
		for (const r of regions) { if ("ok" in r && r.ok) tokens.push(...r.ok); }
		const merged = tokens.join("");

		// Partition disk ops via OpCapture
		const diskOps = this.opCapture.sinceByOrigin(this.forkMark!, DISK_ORIGIN);
		let redundantCount = 0, uniqueCount = 0;
		const diskOpFates: DiskOpFate[] = [];
		const redundant: CapturedOp[] = [];
		const unique: CapturedOp[] = [];
		diskOps.forEach((op, i) => {
			const beforeText = i === 0 ? base : this.ingestionTexts[i - 1];
			const afterText = this.ingestionTexts[i];
			if (isRedundantWithRemote(beforeText, afterText, rem)) {
				redundantCount++;
				diskOpFates.push({ before: beforeText, after: afterText, fate: "reversed" });
				redundant.push(op);
			} else {
				uniqueCount++;
				diskOpFates.push({ before: beforeText, after: afterText, fate: null });
				unique.push(op);
			}
		});

		this.opCapture.reverse(redundant);
		this.opCapture.drop(unique);

		const afterUndo = this.text;
		applyText(this.localDoc, merged);
		this.lastReconcileDetail = { diff3Local: loc, diff3Base: base, diff3Remote: rem, diff3Result: merged, afterUndo, diskOpFates, redundantCount, uniqueCount, editorOpSurvived };
		this.fork = null;
		this.forkMark = null;
		this.ingestionTexts = [];
		this.lca = merged;
		return "synced";
	}
}

function applyText(doc: Y.Doc, t: string, origin?: symbol) {
	const yt = doc.getText("contents");
	const cur = yt.toString();
	if (cur === t) return;
	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(cur, t);
	dmp.diff_cleanupSemantic(diffs);
	doc.transact(() => {
		let c = 0;
		for (const [op, s] of diffs) {
			if (op === 1) { yt.insert(c, s); c += s.length; }
			else if (op === 0) { c += s.length; }
			else { yt.delete(c, s.length); }
		}
	}, origin);
}

function makePeers(content: string): [Peer, Peer] {
	const a = new Peer(), b = new Peer();
	a.localDoc.getText("contents").insert(0, content);
	a.lca = content;
	const upd = Y.encodeStateAsUpdate(a.localDoc);
	Y.applyUpdate(b.localDoc, upd); Y.applyUpdate(a.remoteDoc, upd); Y.applyUpdate(b.remoteDoc, upd);
	b.lca = content;
	return [a, b];
}

function syncRemote(from: Peer, to: Peer) {
	const update = Y.encodeStateAsUpdate(from.localDoc, Y.encodeStateVector(to.remoteDoc));
	to.receiveRemote(update);
	// If the recipient has no fork (online, ungated), apply to localDoc too
	if (!to.fork) {
		Y.applyUpdate(to.localDoc, Y.encodeStateAsUpdate(from.localDoc, Y.encodeStateVector(to.localDoc)));
		to.lca = to.text;
	}
}

// ─────────────────────────────────────────────────────────────
// Recording types
// ─────────────────────────────────────────────────────────────

interface PeerState {
	editor: string;
	disk: string;
	forkBase: string | null;
	undoStackDepth: number;
	lca: string;
	online: boolean;
}

interface StepRaw {
	eventLabel: string;
	eventType: string;
	note: string;
	alice: PeerState;
	bob: PeerState;
	server: string;
	reconcileDetail?: ReconcileDetail;
	rdPhase?: "inputs" | "result";
	rdPeer?: string;
}

// What gets embedded in the HTML — all text fields replaced with precomputed diff HTML
interface StepRendered {
	eventLabel: string;
	eventType: string;
	note: string;
	alice: { editorHtml: string; diskHtml: string; forkBase: string | null; undoStackDepth: number; lcaHtml: string; lcaChanged: boolean; online: boolean; };
	bob:   { editorHtml: string; diskHtml: string; forkBase: string | null; undoStackDepth: number; lcaHtml: string; lcaChanged: boolean; online: boolean; };
	serverHtml: string;
	rd?: {
		localHtml: string; baseHtml: string; remoteHtml: string;
		afterUndoHtml: string; resultHtml: string | null;
		isConflict: boolean;
		editorOpSurvived: boolean;
		diskOpFates: { beforeHtml: string; afterHtml: string; fate: "reversed" | null }[];
	};
	rdPhase?: "inputs" | "result";
	rdPeer?: string;
}

interface ScenarioData {
	id: string;
	title: string;
	description: string;
	/** Always-visible paragraphs rendered before the beat list — no transition effects. */
	prelude: string[];
	steps: StepRaw[];
	hasBothPeers: boolean;
	hasServer: boolean;
}

// ─────────────────────────────────────────────────────────────
// Scenario runners
// ─────────────────────────────────────────────────────────────

function scenarioEditorUndo(): ScenarioData {
	const steps: StepRaw[] = [];
	const [, bob] = makePeers("Hello");
	let bobDisk = "Hello";
	const server = "Hello";
	const noAlice: PeerState = { editor: "", disk: "", forkBase: null, undoStackDepth: 0, lca: "", online: false };

	const rec = (label: string, type: string, note: string, rd?: ReconcileDetail) =>
		steps.push({ eventLabel: label, eventType: type, note,
			alice: noAlice, bob: { editor: bob.text, disk: bobDisk, forkBase: bob.fork?.base ?? null, undoStackDepth: bob.diskOpCount, lca: bob.lca, online: bob.online }, server, reconcileDetail: rd });

	rec("initial", "initial", 'Bob has a file open in Obsidian. The editor and disk both contain "Hello". Nothing else is happening yet — no collaboration, no external changes.');

	bob.ingestDisk("Hello World");
	bobDisk = "Hello World";
	rec('ingestDisk("Hello World")', "disk", 'Something outside Obsidian — a script, a terminal editor, a formatter — wrote "Hello World" to disk. Relay detects the change and replays it into the CRDT document using a special disk origin tag. This creates a fork: the last clean shared state ("Hello") is frozen as the base, so reconciliation has a reference point later. The op capture log records this — tagged as a disk op so it can be selectively reversed on demand.');

	bob.typeInEditor("Hello World!");
	rec('typeInEditor("Hello World!")', "editor", 'Bob types "!" in the Obsidian editor. This is a normal editor keystroke with a different origin (not the disk origin). The op capture log records it alongside the disk op — but since it\'s not tagged as disk, it won\'t be reversed during reconciliation. The editor now shows "Hello World!" but disk still says "Hello World" — Obsidian hasn\'t flushed the save yet.');

	// Reverse the disk op via OpCapture
	const diskOps = bob.opCapture.sinceByOrigin(bob.forkMark!, DISK_ORIGIN);
	const undoRd: ReconcileDetail = {
		diff3Local: "", diff3Base: "", diff3Remote: "", diff3Result: null,
		afterUndo: "",
		diskOpFates: [{ before: "Hello", after: "Hello World", fate: "reversed" }],
		redundantCount: 1, uniqueCount: 0,
		editorOpSurvived: true,
	};
	bob.opCapture.reverse(diskOps);
	rec("opCapture.reverse(diskOps)", "undo", 'The disk op is reversed — a compensating CRDT transaction removes the " World" insertion. But notice: Bob\'s "!" survives. This is the key guarantee. In a CRDT, every character is anchored to its neighbors in the logical document graph, not to byte offsets. "!" was inserted next to the "o" in "Hello", so when " World" is removed, "!" stays attached to its anchor and is not lost.', undoRd);

	return { id: "editor-undo", hasBothPeers: false, hasServer: false,
		title: "Editor op survives disk op undo",
		description: "When a disk change gets undone, any typing you did on top of it is preserved. This is the foundation of safe disk ingestion.",
		prelude: [
			"Obsidian notes are just files on disk. That means any app can edit them — terminal editors, scripts, Git, formatters. Relay is built around this reality.",
			"When an external tool changes a file, Obsidian detects it. Relay needs to absorb that change into its shared document — but carefully, so it can be undone later if the change turns out to conflict with what collaborators were doing.",
			"To do this, Relay records all CRDT operations in an op capture log — every origin, every keystroke. Disk changes are tagged with a special disk origin, so they can be selectively reversed later without disturbing anything the user typed in the editor.",
			"This scenario shows why that matters: even after the disk change is undone, the user's editor work is still there.",
		],
		steps };
}

function scenario4(): ScenarioData {
	const steps: StepRaw[] = [];
	const [alice, bob] = makePeers("line1\nline2\nline3");
	let aliceDisk = "line1\nline2\nline3";
	let bobDisk = "line1\nline2\nline3";
	let server = "line1\nline2\nline3";

	const rec = (label: string, type: string, note: string, rd?: ReconcileDetail, rdPhase?: "inputs" | "result", rdPeer?: string) =>
		steps.push({ eventLabel: label, eventType: type, note,
			alice: { editor: alice.text, disk: aliceDisk, forkBase: alice.fork?.base ?? null, undoStackDepth: alice.diskOpCount, lca: alice.lca, online: alice.online },
			bob:   { editor: bob.text,   disk: bobDisk,   forkBase: bob.fork?.base ?? null,   undoStackDepth: bob.diskOpCount,   lca: bob.lca,   online: bob.online },
			server, reconcileDetail: rd, rdPhase, rdPeer });

	rec("initial", "initial", "Alice and Bob both have the same note open. Three lines, all in sync across editor, disk, and server. This is the baseline — both peers agree on the content.");

	bob.goOffline();
	alice.typeInEditor("line1\nALICE\nline3");
	aliceDisk = alice.text;
	server = alice.text;
	rec('alice types in editor', "editor", "Alice edits paragraph 2 while online. Because she is connected to the Relay server, her CRDT operation flows to the server immediately. Obsidian also writes her change back to her disk. Alice's editor, disk, and the server are all in sync.");

	bob.ingestDisk("line1\nline2\nBOB");
	bobDisk = "line1\nline2\nBOB";
	rec('bob disk edit (vim)', "disk", "Bob has been offline. He opened the file in vim and edited paragraph 3. When Obsidian comes back, it detects the disk change and ingests it into the CRDT with a disk origin tag. A fork is created — the shared state before Bob went offline is frozen as the base. A gate closes: Bob's local CRDT ops are held back and won't reach the server until reconciliation succeeds.");

	bob.goOnline();
	syncRemote(alice, bob);
	rec("server sync", "sync", "Bob reconnects to the Relay server. Alice's paragraph-2 change (which has been on the server this whole time) flows into Bob's remote document copy. Bob can now see what Alice did, even though his gate is still closed — he's just catching up on what he missed.");

	// Partition step (before reconcile modifies state)
	const partitionRd = bob.computePartition();
	rec("partition: classify disk ops", "partition", "Before merging, each disk op is checked against the remote. Redundant ops (already on the server) are reversed to keep disk edits idempotent. Novel ops are kept — they're just regular ops whose content will flow through the merge. Bob's disk op (line3 → BOB) is novel, so it's kept.", partitionRd, "inputs", "Bob");

	bob.reconcile();
	bobDisk = bob.text;
	server = bob.text;
	rec("reconcile() → synced", "reconcile", "diff3 compares three versions: Bob's local after partition, the frozen base, and Alice's remote. Alice changed line 2; Bob contributed line 3 — non-overlapping regions merge automatically. The merged result is applied as a canonical CRDT op, the fork closes, and the gate opens.", bob.lastReconcileDetail, "result", "Bob");

	syncRemote(bob, alice);
	aliceDisk = alice.text;
	rec("bob → alice sync", "sync", "Bob's reconciled canonical op flows from the server to Alice. Her CRDT absorbs the change — editor and disk update to include Bob's line-3 contribution. Both vaults are fully in sync.");

	return { id: "scenario-4", hasBothPeers: true, hasServer: true,
		title: "Non-overlapping offline edits",
		description: "Alice edits while Bob is offline. When Bob reconnects, Relay automatically merges both changes because they touched different parts of the document.",
		prelude: [
			"This is the most common collaboration pattern: one person is editing online, another is offline. When the offline person reconnects, both sets of changes need to merge cleanly.",
			"Relay uses a three-way merge algorithm called diff3. The key ingredients are: (1) the base — the last state both parties agreed on, (2) what Alice ended up with, and (3) what Bob ended up with. Changes to non-overlapping regions merge automatically.",
			"The fork is the period while Bob's document is gated — his changes are held locally while Relay figures out what to do with them. Once reconciliation succeeds, the gate opens and his ops flow to the server as clean canonical operations.",
			"The debugger on the right shows Bob's editor, disk, and the server state at each step. Watch the base badge appear when the fork is created, and disappear when it resolves.",
		],
		steps };
}

function scenario5(): ScenarioData {
	const steps: StepRaw[] = [];
	const [alice, bob] = makePeers("line1\nshared line\nline3");
	let aliceDisk = "line1\nshared line\nline3";
	let bobDisk = "line1\nshared line\nline3";
	let server = "line1\nshared line\nline3";

	const rec = (label: string, type: string, note: string, rd?: ReconcileDetail, rdPhase?: "inputs" | "result", rdPeer?: string) =>
		steps.push({ eventLabel: label, eventType: type, note,
			alice: { editor: alice.text, disk: aliceDisk, forkBase: alice.fork?.base ?? null, undoStackDepth: alice.diskOpCount, lca: alice.lca, online: alice.online },
			bob:   { editor: bob.text,   disk: bobDisk,   forkBase: bob.fork?.base ?? null,   undoStackDepth: bob.diskOpCount,   lca: bob.lca,   online: bob.online },
			server, reconcileDetail: rd, rdPhase, rdPeer });

	rec("initial", "initial", "Both peers start from the same three-line note. They're about to edit the same line — the middle one.");

	bob.goOffline();
	alice.typeInEditor("line1\nALICE VERSION\nline3");
	aliceDisk = alice.text;
	server = alice.text;
	rec("alice rewrites middle line", "editor", "Alice rewrites paragraph 2 while online. Her change reaches the server. Her disk is updated by Obsidian.");

	bob.ingestDisk("line1\nBOB VERSION\nline3");
	bobDisk = "line1\nBOB VERSION\nline3";
	rec("bob disk edit: same region", "disk", "Bob, offline, also rewrites paragraph 2 — to something completely different. Disk change detected, fork created. The base is frozen at the state before either edit.");

	bob.goOnline();
	syncRemote(alice, bob);
	rec("server sync", "sync", "Bob reconnects. Alice's version of paragraph 2 arrives in Bob's remote document. Now Bob's local document has his version, and the remote has Alice's version.");

	bob.reconcile();
	rec("reconcile() → conflict", "reconcile", "diff3 sees that both Alice and Bob changed the same line starting from the same base — and they chose different content. This is a genuine conflict that can't be resolved automatically. The fork is preserved so the conflict resolution UI can present both versions to the user.", bob.lastReconcileDetail, undefined, "Bob");

	return { id: "scenario-5", hasBothPeers: true, hasServer: true,
		title: "Conflict: both edited the same line",
		description: "When two people change the same part of a document to different things, Relay can't pick a winner automatically. The fork is preserved for the user to resolve.",
		prelude: [
			"diff3 merges automatically when edits are to different parts of the document. But when two people change the exact same lines to different content, there's no safe automatic choice — that's a conflict.",
			"Relay detects this case and preserves the fork rather than picking a side. The conflict resolution UI can then present both versions and let the user decide.",
			"Conflicts are uncommon in practice because most Obsidian users write in different files or different sections. But when they happen, Relay surfaces them clearly rather than silently losing someone's work.",
		],
		steps };
}

function scenario6(): ScenarioData {
	const steps: StepRaw[] = [];
	const [alice, bob] = makePeers("See [[meeting-notes]] for details");
	let aliceDisk = "See [[meeting-notes]] for details";
	let bobDisk   = "See [[meeting-notes]] for details";
	let server    = "See [[meeting-notes]] for details";

	const rec = (label: string, type: string, note: string, rd?: ReconcileDetail, rdPhase?: "inputs" | "result", rdPeer?: string) =>
		steps.push({ eventLabel: label, eventType: type, note,
			alice: { editor: alice.text, disk: aliceDisk, forkBase: alice.fork?.base ?? null, undoStackDepth: alice.diskOpCount, lca: alice.lca, online: alice.online },
			bob:   { editor: bob.text,   disk: bobDisk,   forkBase: bob.fork?.base ?? null,   undoStackDepth: bob.diskOpCount,   lca: bob.lca,   online: bob.online },
			server, reconcileDetail: rd, rdPhase, rdPeer });

	rec("initial", "initial", 'Both vaults reference the same note via a wikilink: [[meeting-notes]]. That note is about to be renamed, triggering automatic link repair on both machines.');

	alice.goOffline();
	alice.ingestDisk("See [[weekly-sync]] for details");
	aliceDisk = alice.text;
	rec("alice wikilink repair (disk edit)", "disk", "Alice's vault detects the rename and automatically rewrites [[meeting-notes]] to [[weekly-sync]] on disk. Relay ingests this as a disk change and creates a fork. Alice's gate closes.");

	bob.goOffline();
	bob.ingestDisk("See [[weekly-sync]] for details");
	bobDisk = bob.text;
	rec("bob wikilink repair (disk edit)", "disk", "Bob's vault does the same thing independently — the same repair, to the same content. Another fork is created on Bob's side. Neither machine has talked to the server yet. Two disk writes, same result.");

	// Alice reconnects first — partition + reconcile
	alice.goOnline();
	const alicePartitionRd = alice.computePartition();
	rec("partition: classify alice's disk ops", "partition", "Alice reconnects first. Her disk op is checked against the remote — which hasn't changed. The wikilink repair is novel (the server still has [[meeting-notes]]), so it's kept.", alicePartitionRd, "inputs", "Alice");

	alice.reconcile();
	aliceDisk = alice.text;
	server = alice.text;
	rec("alice reconcile() → synced", "reconcile", "Alice's diff3 is trivial — the remote hasn't changed, so her local version wins outright. The kept disk op flows through the merge as a canonical CRDT operation. Fork closes, gate opens, and the op reaches the server.", alice.lastReconcileDetail, "result", "Alice");

	// alice → bob sync
	bob.goOnline();
	syncRemote(alice, bob);
	rec("alice → bob sync", "sync", "Alice's canonical op flows to Bob's remote document. Bob can now see that Alice made the identical wikilink repair — from the identical base.");

	// Bob partition + reconcile
	const bobPartitionRd = bob.computePartition();
	rec("partition: classify bob's disk ops", "partition", "Bob's disk op is checked against the remote — which now has Alice's identical wikilink repair. The op is redundant (the server already has this change), so it's reversed and discarded.", bobPartitionRd, "inputs", "Bob");

	bob.reconcile();
	bobDisk = bob.text;
	rec("bob reconcile() → synced", "reconcile", "After reversing Bob's redundant disk op, diff3 sees no local change — everything came from the remote. The merge result matches what Alice already put on the server. Bob's fork closes. Two disk writes, one canonical CRDT operation. No duplication.", bob.lastReconcileDetail, "result", "Bob");

	return { id: "scenario-6", hasBothPeers: true, hasServer: true,
		title: "Wikilink repair: same change, two machines",
		description: "Obsidian automatically repairs wikilinks when you rename a note. When this happens on both machines, Relay deduplicates the edit — two disk writes produce one canonical CRDT operation.",
		prelude: [
			"Obsidian has a feature called wikilinks: [[note-name]] references that automatically update when you rename a note. This is handled by Obsidian itself — it writes the corrected link directly to disk on every device that has the vault open.",
			"That creates a tricky situation for Relay. Both Alice's and Bob's Obsidian will write the same change to disk. If Relay treated both as new edits and broadcast both, the change would appear twice in the CRDT — a duplication bug.",
			"The fix: when reconciling, Relay checks whether a disk edit is redundant — meaning the server already has the same change. If so, the disk op is reversed and discarded rather than broadcast. Two disk writes, one canonical CRDT operation.",
		],
		steps };
}

function scenarioThreeSource(): ScenarioData {
	const steps: StepRaw[] = [];
	const [alice, bob] = makePeers("line1\nline2\nline3");
	let aliceDisk = "line1\nline2\nline3";
	let bobDisk   = "line1\nline2\nline3";
	let server    = "line1\nline2\nline3";

	const rec = (label: string, type: string, note: string, rd?: ReconcileDetail, rdPhase?: "inputs" | "result", rdPeer?: string) =>
		steps.push({ eventLabel: label, eventType: type, note,
			alice: { editor: alice.text, disk: aliceDisk, forkBase: alice.fork?.base ?? null, undoStackDepth: alice.diskOpCount, lca: alice.lca, online: alice.online },
			bob:   { editor: bob.text,   disk: bobDisk,   forkBase: bob.fork?.base ?? null,   undoStackDepth: bob.diskOpCount,   lca: bob.lca,   online: bob.online },
			server, reconcileDetail: rd, rdPhase, rdPeer });

	rec("initial", "initial", "Three lines, three contributors. Alice will edit remotely via the Relay server. An external process will change Bob's disk. And Bob will type in the editor. All to different lines — so everything can merge.");

	bob.goOffline();
	alice.typeInEditor("REMOTE\nline2\nline3");
	aliceDisk = alice.text;
	server = alice.text;
	rec("alice edits line 1", "editor", "Alice rewrites line 1 while online. Her CRDT op flows to the server immediately and her disk updates. This will arrive in Bob's remote document when he syncs.");

	bob.ingestDisk("line1\nDISK\nline3");
	bobDisk = "line1\nDISK\nline3";
	rec("bob disk edit: line 2", "disk", "An external process — maybe a script or a Git merge — rewrites line 2 on Bob's disk. Relay detects the file change, ingests it with a disk origin tag, and creates a fork. Bob's gate closes.");

	bob.typeInEditor("line1\nDISK\nEDITOR");
	rec("bob types in editor: line 3", "editor", "Bob notices line 3 and types a correction directly in Obsidian — on top of the current disk content. The op capture log records this editor keystroke too, but since it's not tagged as a disk op, it won't be reversed during reconciliation. It will survive when the disk op is later reversed.");

	bob.goOnline();
	syncRemote(alice, bob);
	rec("server sync", "sync", "Bob reconnects. Alice's line-1 change arrives in Bob's remote document. Bob can now see all three sources: Alice's remote change, his disk change, and his editor change.");

	const partitionRd = bob.computePartition();
	rec("partition: classify disk ops", "partition", "Before merging, each disk op is checked against the remote. Bob's disk op (line2 → DISK) is novel — the server doesn't have it, so it's kept. His editor op (line3 → EDITOR) is a native CRDT operation, not a disk op — it survives the merge automatically without classification.", partitionRd, "inputs", "Bob");

	bob.reconcile();
	bobDisk = bob.text;
	server = bob.text;
	rec("reconcile() → synced", "reconcile", "diff3 compares three versions: Bob's local after disk-op reversal, the frozen base, and Alice's remote. Each source touched a different line — non-overlapping regions merge automatically. Bob's editor op survives anchored to its CRDT position. The merged result is applied as a canonical CRDT op, the fork closes, and the gate opens.", bob.lastReconcileDetail, "result", "Bob");

	syncRemote(bob, alice);
	aliceDisk = alice.text;
	rec("bob → alice sync", "sync", "Bob's reconciled canonical op flows from the server to Alice. Her CRDT absorbs Bob's disk and editor contributions. Both vaults are fully in sync — all three sources preserved.");

	return { id: "three-source", hasBothPeers: true, hasServer: true,
		title: "Three-source merge: remote + disk + editor",
		description: "The most complex normal case: Bob has a disk edit, an editor edit, and an incoming remote edit — all to different lines. All three survive in the final merged document.",
		prelude: [
			"In real use, changes come from multiple places at once. You might be typing in Obsidian while a script modifies files in the background and a collaborator sends changes from across the network.",
			"Relay handles this by separating concerns. Disk ops are tagged separately from editor ops. During reconciliation, the disk ops are reversed from the CRDT history, the merge runs against the cleaned-up document, and editor ops — which are CRDT-native — survive because they're anchored to their logical neighbors, not byte positions.",
			"This scenario shows all three sources at once: a remote change from Alice, a disk change from an external process, and a direct editor keystroke from Bob. All to different lines, so diff3 can merge them automatically.",
		],
		steps };
}

function scenarioMultiDisk(): ScenarioData {
	// Two offline disk edits: a novel addition followed by a wikilink repair.
	// The wikilink repair is redundant (same change Alice already made remotely).
	// The novel addition is unique (local-only contribution).
	// OpCapture handles selective reversal — no LIFO constraint.
	const steps: StepRaw[] = [];
	const [alice, bob] = makePeers("[[old-link]]\nnote content");
	let aliceDisk = "[[old-link]]\nnote content";
	let bobDisk   = "[[old-link]]\nnote content";
	let server    = "[[old-link]]\nnote content";

	const rec = (label: string, type: string, note: string, rd?: ReconcileDetail, rdPhase?: "inputs" | "result", rdPeer?: string) =>
		steps.push({ eventLabel: label, eventType: type, note,
			alice: { editor: alice.text, disk: aliceDisk, forkBase: alice.fork?.base ?? null, undoStackDepth: alice.diskOpCount, lca: alice.lca, online: alice.online },
			bob:   { editor: bob.text,   disk: bobDisk,   forkBase: bob.fork?.base ?? null,   undoStackDepth: bob.diskOpCount,   lca: bob.lca,   online: bob.online },
			server, reconcileDetail: rd, rdPhase, rdPeer });

	rec("initial", "initial", 'Both vaults start from the same note: a wikilink at the top, note content below. Bob is about to go offline. While he\'s gone, two things will happen to his disk.');

	bob.goOffline();
	alice.typeInEditor("[[weekly-sync]]\nnote content");
	aliceDisk = alice.text;
	server = alice.text;
	rec("alice repairs wikilink (online)", "editor", "Alice renames the linked note. Her Obsidian rewrites [[old-link]] to [[weekly-sync]] on disk and broadcasts the CRDT op to the server. Bob is offline — he won't see this until he reconnects.");

	bob.ingestDisk("[[old-link]]\nnote content\nnew paragraph");
	bobDisk = "[[old-link]]\nnote content\nnew paragraph";
	rec("bob disk edit 1: novel addition (offline)", "disk", "Bob adds a new paragraph to the note using an external editor while offline. Relay detects the disk change, ingests it with a disk origin tag, and creates a fork. The link is still the old one — Bob hasn't seen Alice's rename yet.");

	bob.ingestDisk("[[weekly-sync]]\nnote content\nnew paragraph");
	bobDisk = bob.text;
	rec("bob disk edit 2: wikilink repair (offline)", "disk", "Bob's Obsidian also detects the renamed note and automatically repairs the wikilink on disk — the same change Alice already made. A second disk op is recorded on top of the first. Bob's CRDT history now has two disk-origin entries.");

	bob.goOnline();
	syncRemote(alice, bob);
	rec("server sync", "sync", "Bob reconnects. Alice's wikilink repair op flows into Bob's remote document. Now Bob's local CRDT has two disk ops, and the remote has Alice's equivalent of disk op 2.");

	const partitionRd = bob.computePartition();
	rec("partition: classify disk ops", "partition", "Before merging, each disk op is checked against the remote. Disk op 1 (new paragraph) is novel — the server doesn't have it, so it's kept. Disk op 2 (wikilink repair) is redundant — the server already has this exact change from Alice, so it's reversed and discarded.", partitionRd, "inputs", "Bob");

	bob.reconcile();
	bobDisk = bob.text;
	server = bob.text;
	rec("reconcile() → synced", "reconcile",
		"diff3 compares Bob's local after partition (redundant wikilink op reversed, novel paragraph kept), the frozen base, and Alice's remote. The wikilink repair merges from the remote; the new paragraph merges from the local. The merged result is applied as a canonical CRDT op, the fork closes, and the gate opens.",
		bob.lastReconcileDetail, "result", "Bob");

	syncRemote(bob, alice);
	aliceDisk = alice.text;
	rec("bob → alice sync", "sync", "Bob's reconciled canonical op flows from the server to Alice. Her CRDT absorbs the new paragraph. Both vaults are fully in sync — the wikilink repair exists once, and Bob's novel paragraph is preserved.");

	return { id: "multi-disk", hasBothPeers: true, hasServer: true,
		title: "Two offline disk edits: novel + redundant",
		description: "Bob accumulates two disk changes while offline: a new paragraph (unique to Bob) and a wikilink repair (same as Alice's). Relay keeps the novel content and discards the duplicate.",
		prelude: [
			"Real offline sessions produce multiple disk changes. You might add a paragraph in one app, then have Obsidian automatically repair a wikilink — two separate writes to the same file.",
			"When reconciling, Relay can't treat all disk ops the same way. Some are genuinely new content that needs to survive. Others are copies of changes the server already has — broadcasting them again would create duplicates.",
			"The partition step classifies each disk op: if the remote already has the change, the op is reversed and thrown away (redundant). If the remote doesn't have it, the op is dropped from CRDT history and the merge result re-applies its contribution (unique). Both kinds of content end up in the final document exactly once.",
		],
		steps };
}

// ─────────────────────────────────────────────────────────────
// Rendering helpers
// ─────────────────────────────────────────────────────────────

function esc(s: string) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function diffHtml(prev: string, curr: string): string {
	const d = new diff_match_patch();
	const diffs = d.diff_main(prev, curr);
	d.diff_cleanupSemantic(diffs);
	return diffs.map(([op, text]) => {
		const e = esc(text).replace(/\n/g, "↵\n");
		if (op === 1) return `<span class="ins">${e}</span>`;
		if (op === -1) return `<span class="del">${e}</span>`;
		return e;
	}).join("");
}

function plainHtml(s: string) {
	return esc(s).replace(/\n/g, "↵\n");
}

function prerender(scenarios: ScenarioData[]): StepRendered[][] {
	return scenarios.map(sc => {
		return sc.steps.map((step, i) => {
			const prev = i > 0 ? sc.steps[i - 1] : null;

			const peerHtml = (curr: PeerState, prevP: PeerState | null) => ({
				editorHtml: prevP ? diffHtml(prevP.editor, curr.editor) : plainHtml(curr.editor),
				diskHtml:   prevP ? diffHtml(prevP.disk,   curr.disk)   : plainHtml(curr.disk),
				forkBase:   curr.forkBase,
				undoStackDepth: curr.undoStackDepth,
				lcaHtml:    plainHtml(curr.lca),
				lcaChanged: prevP ? curr.lca !== prevP.lca : false,
				online:     curr.online,
			});

			const rd = step.reconcileDetail;
			let rdRendered: StepRendered["rd"];
			if (rd) {
				rdRendered = {
					localHtml:  plainHtml(rd.diff3Local),
					baseHtml:   plainHtml(rd.diff3Base),
					remoteHtml: plainHtml(rd.diff3Remote),
					afterUndoHtml: diffHtml(rd.diff3Local, rd.afterUndo),
					resultHtml: rd.diff3Result !== null ? diffHtml(rd.afterUndo, rd.diff3Result) : null,
					isConflict: rd.diff3Result === null,
					editorOpSurvived: rd.editorOpSurvived,
					diskOpFates: rd.diskOpFates.map(f => ({
						beforeHtml: plainHtml(f.before),
						afterHtml:  diffHtml(f.before, f.after),
						fate: f.fate,
					})),
				};
			}

			const out: StepRendered = {
				eventLabel: step.eventLabel,
				eventType:  step.eventType,
				note:       step.note,
				alice: peerHtml(step.alice, prev?.alice ?? null),
				bob:   peerHtml(step.bob,   prev?.bob   ?? null),
				serverHtml: prev ? diffHtml(prev.server, step.server) : plainHtml(step.server),
				rd: rdRendered,
			};
			if (step.rdPhase) out.rdPhase = step.rdPhase;
			if (step.rdPeer)  out.rdPeer  = step.rdPeer;
			return out;
		});
	});
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const scenarios = [
	scenarioEditorUndo(),
	scenario4(),
	scenario5(),
	scenario6(),
	scenarioMultiDisk(),
	scenarioThreeSource(),
];

const rendered = prerender(scenarios);
const scenariosJson = JSON.stringify(scenarios.map((sc, si) => ({
	id: sc.id,
	title: sc.title,
	description: sc.description,
	prelude: sc.prelude,
	hasBothPeers: sc.hasBothPeers,
	hasServer: sc.hasServer,
	steps: rendered[si],
})), null, 2);
const outPath = join(__dirname, "scenarios.js");
writeFileSync(outPath, `const SCENARIOS = ${scenariosJson};\n`, "utf8");
console.log(`✓ ${outPath}`);
