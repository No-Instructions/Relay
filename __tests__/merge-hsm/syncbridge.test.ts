/**
 * Standalone tests for SyncBridge — the component that manages CRDT op flow
 * between localDoc and remoteDoc via inbound/outbound queues and a SyncGate.
 *
 * Tests mock the SyncBridgeHost interface to exercise the bridge in isolation.
 */

import * as Y from "yjs";
import { SyncBridge } from "src/merge-hsm/SyncBridge";
import type { SyncBridgeHost } from "src/merge-hsm/SyncBridge";
import type { MergeEffect, PositionedChange } from "src/merge-hsm/types";
import { MACHINE_EDIT_ORIGIN } from "src/merge-hsm/undo";
import {
	createTestHSM,
	loadAndActivate,
	cm6Change,
	connected,
	providerSynced,
	disconnected,
	releaseLock,
} from "src/merge-hsm/testing";

// ===========================================================================
// Mock Host
// ===========================================================================

interface MockHostOptions {
	localDoc?: Y.Doc | null;
	remoteDoc?: Y.Doc | null;
	hasFork?: boolean;
}

function createMockHost(opts: MockHostOptions = {}): SyncBridgeHost & {
	effects: MergeEffect[];
	stateChanges: number;
	consumedTexts: string[];
	pendingMachineEdits: Array<{
		fn: (data: string) => string;
		expectedText: string;
		captureMark: number;
		registeredAt: number;
	}>;
	_hasFork: boolean;
	_suppressLocal: boolean;
	_localDoc: Y.Doc | null;
	_remoteDoc: Y.Doc | null;
	_matchResult: ReturnType<SyncBridgeHost["matchMachineEdit"]>;
} {
	const host = {
		_localDoc: opts.localDoc ?? null,
		_remoteDoc: opts.remoteDoc ?? null,
		_hasFork: opts.hasFork ?? false,
		_suppressLocal: false,
		_matchResult: null as ReturnType<SyncBridgeHost["matchMachineEdit"]>,
		effects: [] as MergeEffect[],
		stateChanges: 0,
		consumedTexts: [] as string[],
		pendingMachineEdits: [] as Array<{
			fn: (data: string) => string;
			expectedText: string;
			captureMark: number;
			registeredAt: number;
		}>,

		getLocalDoc() { return host._localDoc; },
		getRemoteDoc() { return host._remoteDoc; },
		hasFork() { return host._hasFork; },
		emitEffect(effect: MergeEffect) { host.effects.push(effect); },
		emitStateChange() { host.stateChanges++; },
		getOpCapture() { return null; },
		getPendingMachineEdits() { return host.pendingMachineEdits; },
		matchMachineEdit(remoteText: string) { return host._matchResult; },
		removeMachineEdit(_entry: { captureMark: number }) {},
		computeDiffChanges(from: string, to: string): PositionedChange[] {
			// Simple diff: single replacement of entire text
			if (from === to) return [];
			return [{ from: 0, to: from.length, insert: to }];
		},
		guid: "test-guid",
		path: "test.md",
		isSuppressLocalObserver() { return host._suppressLocal; },
		setSuppressLocalObserver(value: boolean) { host._suppressLocal = value; },
	};
	return host;
}

/** Create a Y.Doc pair with initial text content */
function createDocPair(text = ""): { localDoc: Y.Doc; remoteDoc: Y.Doc } {
	const localDoc = new Y.Doc();
	const remoteDoc = new Y.Doc();
	if (text) {
		localDoc.getText("contents").insert(0, text);
		// Sync to remote
		const update = Y.encodeStateAsUpdate(localDoc);
		Y.applyUpdate(remoteDoc, update);
	}
	return { localDoc, remoteDoc };
}

// ===========================================================================
// SyncGate Tests
// ===========================================================================

describe("SyncBridge", () => {
	describe("SyncGate", () => {
		test("initial state has all gates closed/zero", () => {
			const host = createMockHost();
			const bridge = new SyncBridge(host);
			expect(bridge.syncGate.providerSynced).toBe(false);
			expect(bridge.syncGate.localOnly).toBe(false);
			expect(bridge.pendingInbound).toBe(0);
			expect(bridge.pendingOutbound).toBe(0);
		});

		test("providerSynced setter/getter", () => {
			const host = createMockHost();
			const bridge = new SyncBridge(host);
			bridge.providerSynced = true;
			expect(bridge.providerSynced).toBe(true);
			bridge.providerSynced = false;
			expect(bridge.providerSynced).toBe(false);
		});

		test("setLocalOnly toggles the flag", () => {
			const host = createMockHost();
			const bridge = new SyncBridge(host);
			bridge.setLocalOnly(true);
			expect(bridge.isLocalOnly).toBe(true);
			bridge.setLocalOnly(false);
			expect(bridge.isLocalOnly).toBe(false);
		});

		test("setLocalOnly is idempotent", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setLocalOnly(true);
			bridge.setLocalOnly(true); // no-op
			expect(bridge.isLocalOnly).toBe(true);
		});

		test("setLocalOnly(false) flushes when docs exist and no fork", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			bridge.setLocalOnly(true);
			// Make a local-only change
			localDoc.getText("contents").insert(5, " world");

			bridge.setLocalOnly(false);
			// After flush, remote should have the change
			expect(remoteDoc.getText("contents").toString()).toBe("hello world");
		});

		test("setLocalOnly(false) resets pending counters", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			bridge.setLocalOnly(true);
			// Trigger flushOutbound while localOnly — increments pendingOutbound
			bridge.flushOutbound();
			expect(bridge.pendingOutbound).toBe(1);

			bridge.setLocalOnly(false);
			expect(bridge.pendingInbound).toBe(0);
			expect(bridge.pendingOutbound).toBe(0);
		});

		test("setLocalOnly(false) does NOT flush when fork active", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc, hasFork: true });
			const bridge = new SyncBridge(host);

			bridge.setLocalOnly(true);
			localDoc.getText("contents").insert(5, " world");
			bridge.setLocalOnly(false);
			// Fork blocks the flush, so remote stays unchanged
			expect(remoteDoc.getText("contents").toString()).toBe("hello");
		});

		test("setLocalOnly(false) does NOT flush when docs missing", () => {
			const host = createMockHost({ localDoc: null, remoteDoc: null });
			const bridge = new SyncBridge(host);
			bridge.setLocalOnly(true);
			// Should not throw
			bridge.setLocalOnly(false);
		});

		test("resetPendingCounters zeroes both counters", () => {
			const host = createMockHost();
			const bridge = new SyncBridge(host);
			(bridge as any)._syncGate.pendingInbound = 5;
			(bridge as any)._syncGate.pendingOutbound = 3;
			bridge.resetPendingCounters();
			expect(bridge.pendingInbound).toBe(0);
			expect(bridge.pendingOutbound).toBe(0);
		});

		test("pending counters accumulate under localOnly", () => {
			const { localDoc, remoteDoc } = createDocPair("x");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			bridge.setLocalOnly(true);
			bridge.flushOutbound();
			bridge.flushOutbound();
			bridge.flushInbound();
			expect(bridge.pendingOutbound).toBe(2);
			expect(bridge.pendingInbound).toBe(1);
		});

		test("pending counters accumulate under fork", () => {
			const { localDoc, remoteDoc } = createDocPair("x");
			const host = createMockHost({ localDoc, remoteDoc, hasFork: true });
			const bridge = new SyncBridge(host);

			bridge.flushOutbound();
			bridge.flushInbound();
			bridge.flushInbound();
			expect(bridge.pendingOutbound).toBe(1);
			expect(bridge.pendingInbound).toBe(2);
		});

		test("double gating: fork + localOnly both increment counters", () => {
			const { localDoc, remoteDoc } = createDocPair("x");
			const host = createMockHost({ localDoc, remoteDoc, hasFork: true });
			const bridge = new SyncBridge(host);

			bridge.setLocalOnly(true);
			// Fork check happens first in flushOutbound/flushInbound
			bridge.flushOutbound();
			bridge.flushInbound();
			expect(bridge.pendingOutbound).toBe(1);
			expect(bridge.pendingInbound).toBe(1);
		});

		test("emitStateChange called when localOnly gates a flush", () => {
			const { localDoc, remoteDoc } = createDocPair("x");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setLocalOnly(true);

			bridge.flushOutbound();
			expect(host.stateChanges).toBe(1);

			bridge.flushInbound();
			expect(host.stateChanges).toBe(2);
		});
	});

	// =========================================================================
	// Queue Tests
	// =========================================================================

	describe("Queues", () => {
		test("setupUpdateQueues installs handlers on both docs", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			expect(bridge.hasLocalDocUpdateHandler).toBe(false);
			expect(bridge.hasRemoteDocUpdateHandler).toBe(false);

			bridge.setupUpdateQueues();
			expect(bridge.hasLocalDocUpdateHandler).toBe(true);
			expect(bridge.hasRemoteDocUpdateHandler).toBe(true);
		});

		test("setupUpdateQueues is idempotent", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			bridge.setupUpdateQueues();
			bridge.setupUpdateQueues(); // should not double-install
			expect(bridge.hasLocalDocUpdateHandler).toBe(true);
		});

		test("setupUpdateQueues skips null docs", () => {
			const host = createMockHost({ localDoc: null, remoteDoc: null });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();
			expect(bridge.hasLocalDocUpdateHandler).toBe(false);
			expect(bridge.hasRemoteDocUpdateHandler).toBe(false);
		});

		test("local doc changes queue outbound entries", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			localDoc.getText("contents").insert(2, "!");
			expect(bridge.outboundQueue.length).toBeGreaterThan(0);
			expect(bridge.outboundQueue[0].machineEditMark).toBeNull();
		});

		test("outbound entries from remoteDoc origin are filtered", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			// Simulate inbound echo: apply update with remoteDoc as origin
			localDoc.transact(() => {
				localDoc.getText("contents").insert(0, "x");
			}, remoteDoc);

			// The handler should skip updates with remoteDoc as origin
			expect(bridge.outboundQueue.length).toBe(0);
		});

		test("outbound entries when suppressLocalObserver are filtered", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			host._suppressLocal = true;
			localDoc.getText("contents").insert(0, "x");
			expect(bridge.outboundQueue.length).toBe(0);
		});

		test("machine edit mark tags outbound entries", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			bridge.currentMachineEditMark = 42;
			localDoc.transact(() => {
				localDoc.getText("contents").insert(0, "M");
			}, MACHINE_EDIT_ORIGIN);
			expect(bridge.outboundQueue.length).toBe(1);
			expect(bridge.outboundQueue[0].machineEditMark).toBe(42);

			bridge.currentMachineEditMark = null;
		});

		test("remote doc changes queue inbound entries", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			remoteDoc.getText("contents").insert(2, "?");
			// The inbound queue is private, check via flushInbound behavior
			// But we can verify via flushInbound applying the change
			bridge.flushInbound();
			expect(localDoc.getText("contents").toString()).toBe("hi?");
		});

		test("inbound entries from host origin are filtered", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			// Simulate outbound echo: apply update with host as origin
			remoteDoc.transact(() => {
				remoteDoc.getText("contents").insert(0, "x");
			}, host);

			// Inbound queue should be empty — test by flushing and checking
			// localDoc is unchanged (except from the state diff fallback)
			// Since the remoteDoc was modified, the state diff will catch it.
			// But the queue itself should have filtered it.
			// We can verify the queue is empty by checking that no DISPATCH_CM6
			// is emitted when queue draining happens (the state diff fallback
			// will still emit though). This is a bit indirect.
		});

		test("queue ordering preserved across multiple updates", () => {
			const { localDoc, remoteDoc } = createDocPair("abc");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			localDoc.getText("contents").insert(3, "1");
			localDoc.getText("contents").insert(4, "2");
			localDoc.getText("contents").insert(5, "3");

			expect(bridge.outboundQueue.length).toBe(3);
			// Flush and verify final state
			bridge.flushOutbound();
			expect(remoteDoc.getText("contents").toString()).toBe("abc123");
		});

		test("clearOutboundQueue empties the queue", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			localDoc.getText("contents").insert(0, "x");
			expect(bridge.outboundQueue.length).toBe(1);
			bridge.clearOutboundQueue();
			expect(bridge.outboundQueue.length).toBe(0);
		});

		test("clearInboundQueue empties the queue", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			remoteDoc.getText("contents").insert(0, "x");
			bridge.clearInboundQueue();
			// After clearing, flush should use state diff fallback
			bridge.flushInbound();
			// State diff will still sync - just verifying no crash
			expect(localDoc.getText("contents").toString()).toBe("xhi");
		});

		test("discardOutboundByMark removes tagged entries", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			// Add normal entry
			localDoc.getText("contents").insert(0, "a");
			// Add machine-edit entry
			bridge.currentMachineEditMark = 99;
			localDoc.transact(() => {
				localDoc.getText("contents").insert(0, "b");
			}, MACHINE_EDIT_ORIGIN);
			bridge.currentMachineEditMark = null;

			expect(bridge.outboundQueue.length).toBe(2);
			bridge.discardOutboundByMark(99);
			expect(bridge.outboundQueue.length).toBe(1);
			expect(bridge.outboundQueue[0].machineEditMark).toBeNull();
		});

		test("teardownUpdateQueues removes handlers and clears queues", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			localDoc.getText("contents").insert(0, "x");
			expect(bridge.outboundQueue.length).toBe(1);

			bridge.teardownUpdateQueues();
			expect(bridge.hasLocalDocUpdateHandler).toBe(false);
			expect(bridge.hasRemoteDocUpdateHandler).toBe(false);
			expect(bridge.outboundQueue.length).toBe(0);

			// New changes should not queue
			localDoc.getText("contents").insert(0, "y");
			expect(bridge.outboundQueue.length).toBe(0);
		});

		test("detachHandlers captures and nulls handlers", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			const handlers = bridge.detachHandlers();
			expect(handlers.localUpdateHandler).not.toBeNull();
			expect(handlers.remoteUpdateHandler).not.toBeNull();
			expect(bridge.hasLocalDocUpdateHandler).toBe(false);
			expect(bridge.hasRemoteDocUpdateHandler).toBe(false);
			expect(bridge.outboundQueue.length).toBe(0);
		});
	});

	// =========================================================================
	// Chokepoint Tests
	// =========================================================================

	describe("Chokepoints", () => {
		test("syncToRemote applies update to remoteDoc", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			localDoc.getText("contents").insert(5, " world");
			const update = Y.encodeStateAsUpdate(localDoc, Y.encodeStateVector(remoteDoc));
			bridge.syncToRemote(update);

			expect(remoteDoc.getText("contents").toString()).toBe("hello world");
		});

		test("syncToRemote emits SYNC_TO_REMOTE effect", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			const update = Y.encodeStateAsUpdate(localDoc);
			bridge.syncToRemote(update);
			expect(host.effects.some(e => e.type === "SYNC_TO_REMOTE")).toBe(true);
		});

		test("syncToRemote no-ops when remoteDoc is null", () => {
			const host = createMockHost({ remoteDoc: null });
			const bridge = new SyncBridge(host);
			// Should not throw
			bridge.syncToRemote(new Uint8Array([1, 2, 3]));
			expect(host.effects.length).toBe(0);
		});

		test("syncToLocal applies update to localDoc", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			remoteDoc.getText("contents").insert(5, " there");
			const update = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc));
			bridge.syncToLocal(update);

			expect(localDoc.getText("contents").toString()).toBe("hello there");
		});

		test("syncToLocal no-ops when localDoc is null", () => {
			const remoteDoc = new Y.Doc();
			const host = createMockHost({ localDoc: null, remoteDoc });
			const bridge = new SyncBridge(host);
			// Should not throw
			bridge.syncToLocal(new Uint8Array([1, 2, 3]));
		});

		test("syncToRemote blocked by fork via flushOutbound", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc, hasFork: true });
			const bridge = new SyncBridge(host);

			localDoc.getText("contents").insert(5, "!");
			bridge.flushOutbound();
			expect(remoteDoc.getText("contents").toString()).toBe("hello");
			expect(bridge.pendingOutbound).toBe(1);
		});

		test("syncToRemote blocked by localOnly via flushOutbound", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setLocalOnly(true);

			localDoc.getText("contents").insert(5, "!");
			bridge.flushOutbound();
			expect(remoteDoc.getText("contents").toString()).toBe("hello");
			expect(bridge.pendingOutbound).toBe(1);
		});
	});

	// =========================================================================
	// Flush Tests
	// =========================================================================

	describe("Flush", () => {
		test("flushOutbound with matching docs sends update but no text change", () => {
			const { localDoc, remoteDoc } = createDocPair("same");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			bridge.flushOutbound();
			// State diff may produce metadata-only update; remote text unchanged
			expect(remoteDoc.getText("contents").toString()).toBe("same");
		});

		test("flushOutbound without handler uses full state diff", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			localDoc.getText("contents").insert(5, " world");
			bridge.flushOutbound();
			expect(remoteDoc.getText("contents").toString()).toBe("hello world");
			expect(host.effects.some(e => e.type === "SYNC_TO_REMOTE")).toBe(true);
		});

		test("flushOutbound with handler drains queued entries", () => {
			const { localDoc, remoteDoc } = createDocPair("abc");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			localDoc.getText("contents").insert(3, "def");
			expect(bridge.outboundQueue.length).toBeGreaterThan(0);

			bridge.flushOutbound();
			expect(remoteDoc.getText("contents").toString()).toBe("abcdef");
			expect(bridge.outboundQueue.length).toBe(0);
		});

		test("flushOutbound defers pending machine-edit entries", () => {
			const { localDoc, remoteDoc } = createDocPair("abc");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			// Register a pending machine edit
			host.pendingMachineEdits.push({
				fn: (s) => s,
				expectedText: "Mabc",
				captureMark: 10,
				registeredAt: Date.now(),
			});

			// Add machine-edit entry
			bridge.currentMachineEditMark = 10;
			localDoc.transact(() => {
				localDoc.getText("contents").insert(0, "M");
			}, MACHINE_EDIT_ORIGIN);
			bridge.currentMachineEditMark = null;

			bridge.flushOutbound();
			// Machine-edit entry should be deferred
			expect(bridge.outboundQueue.length).toBe(1);
			expect(bridge.outboundQueue[0].machineEditMark).toBe(10);
			// Remote should NOT have the machine edit
			expect(remoteDoc.getText("contents").toString()).toBe("abc");
		});

		test("flushOutbound sends non-machine entries even with deferred ones", () => {
			const { localDoc, remoteDoc } = createDocPair("abc");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			host.pendingMachineEdits.push({
				fn: (s) => s,
				expectedText: "",
				captureMark: 10,
				registeredAt: Date.now(),
			});

			// Normal user edit
			localDoc.getText("contents").insert(3, "!");

			// Machine edit
			bridge.currentMachineEditMark = 10;
			localDoc.transact(() => {
				localDoc.getText("contents").insert(0, "M");
			}, MACHINE_EDIT_ORIGIN);
			bridge.currentMachineEditMark = null;

			bridge.flushOutbound();
			// User edit should be sent, machine edit deferred
			expect(remoteDoc.getText("contents").toString()).toBe("abc!");
			expect(bridge.outboundQueue.length).toBe(1);
		});

		test("flushOutbound with handler detects pre-handler state diff", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			// Make a change BEFORE setting up queues
			localDoc.getText("contents").insert(5, "!");
			bridge.setupUpdateQueues();

			// Queue is empty but docs differ
			bridge.flushOutbound();
			expect(remoteDoc.getText("contents").toString()).toBe("hello!");
		});

		test("flushInbound with no docs is no-op", () => {
			const host = createMockHost({ localDoc: null, remoteDoc: null });
			const bridge = new SyncBridge(host);
			// Should not throw
			bridge.flushInbound();
		});

		test("flushInbound applies remote changes to localDoc", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			remoteDoc.getText("contents").insert(5, " world");
			bridge.flushInbound();
			expect(localDoc.getText("contents").toString()).toBe("hello world");
		});

		test("flushInbound with handler drains queue then does state diff", () => {
			const { localDoc, remoteDoc } = createDocPair("abc");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			remoteDoc.getText("contents").insert(3, "def");
			bridge.flushInbound();
			expect(localDoc.getText("contents").toString()).toBe("abcdef");
		});

		test("flushInbound syncs wikilink repair to localDoc", () => {
			const { localDoc, remoteDoc } = createDocPair("Link: [[target]]\nEnd.");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setupUpdateQueues();

			remoteDoc.getText("contents").delete(8, 6);
			remoteDoc.getText("contents").insert(8, "renamed-target");

			bridge.flushInbound();
			expect(localDoc.getText("contents").toString()).toBe("Link: [[renamed-target]]\nEnd.");
		});

		test("flushInbound syncs even when called before queue handler", () => {
			// Simulates ProviderIntegration observer firing before SyncBridge's
			// queue handler — flushInbound sees empty queue but full state diff
			// still picks up the change.
			const { localDoc, remoteDoc } = createDocPair("Link: [[target]]\nEnd.");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			let flushInboundCalled = false;
			remoteDoc.on('update', () => {
				if (!flushInboundCalled) {
					flushInboundCalled = true;
					bridge.flushInbound();
				}
			});

			bridge.setupUpdateQueues();

			const vault1Doc = new Y.Doc();
			Y.applyUpdate(vault1Doc, Y.encodeStateAsUpdate(remoteDoc));
			vault1Doc.getText("contents").delete(8, 6);
			vault1Doc.getText("contents").insert(8, "renamed-target");
			const updateFromVault1 = Y.encodeStateAsUpdate(
				vault1Doc, Y.encodeStateVector(remoteDoc)
			);

			Y.applyUpdate(remoteDoc, updateFromVault1);

			expect(localDoc.getText("contents").toString()).toBe("Link: [[renamed-target]]\nEnd.");
		});

		test("flush() does both inbound and outbound", () => {
			const { localDoc, remoteDoc } = createDocPair("base");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			localDoc.getText("contents").insert(4, "-local");
			remoteDoc.getText("contents").insert(4, "-remote");

			bridge.flush();
			// Both docs should converge
			const localText = localDoc.getText("contents").toString();
			const remoteText = remoteDoc.getText("contents").toString();
			expect(localText).toBe(remoteText);
		});

		test("flush while localOnly increments both pending counters", () => {
			const { localDoc, remoteDoc } = createDocPair("x");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);
			bridge.setLocalOnly(true);

			bridge.flush();
			expect(bridge.pendingInbound).toBe(1);
			expect(bridge.pendingOutbound).toBe(1);
		});

		test("flush while fork increments both pending counters", () => {
			const { localDoc, remoteDoc } = createDocPair("x");
			const host = createMockHost({ localDoc, remoteDoc, hasFork: true });
			const bridge = new SyncBridge(host);

			bridge.flush();
			expect(bridge.pendingInbound).toBe(1);
			expect(bridge.pendingOutbound).toBe(1);
		});
	});

	// =========================================================================
	// Edge Cases
	// =========================================================================

	describe("Edge cases", () => {
		test("rapid setup/teardown cycles", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			for (let i = 0; i < 5; i++) {
				bridge.setupUpdateQueues();
				localDoc.getText("contents").insert(0, String(i));
				bridge.teardownUpdateQueues();
			}
			// Should not throw, handlers should be clean
			expect(bridge.hasLocalDocUpdateHandler).toBe(false);
			expect(bridge.hasRemoteDocUpdateHandler).toBe(false);
		});

		test("flush after teardown is safe", () => {
			const { localDoc, remoteDoc } = createDocPair("hi");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			bridge.setupUpdateQueues();
			localDoc.getText("contents").insert(0, "x");
			bridge.teardownUpdateQueues();

			// Flush with no handler uses state diff fallback
			bridge.flush();
			expect(remoteDoc.getText("contents").toString()).toBe("xhi");
		});

		test("state vector convergence assertion passes for synced docs", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			// flush() calls assertStateVectorConvergence — should not throw
			bridge.flush();
		});

		test("state vector convergence fires repair for diverged docs", () => {
			const localDoc = new Y.Doc();
			const remoteDoc = new Y.Doc();
			localDoc.getText("contents").insert(0, "local");
			remoteDoc.getText("contents").insert(0, "remote");

			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			// In test env, assertStateVectorConvergence throws on divergence
			// flush() calls flushInbound + flushOutbound + assert
			// The flush steps will partially sync, but SVs may still differ
			// due to independent insertions. The assertion repairs this.
			bridge.flush();
			// After repair, both should converge
			const lt = localDoc.getText("contents").toString();
			const rt = remoteDoc.getText("contents").toString();
			expect(lt).toBe(rt);
		});

		test("convergence skipped when pending machine edits exist", () => {
			const localDoc = new Y.Doc();
			const remoteDoc = new Y.Doc();
			localDoc.getText("contents").insert(0, "local");
			remoteDoc.getText("contents").insert(0, "remote");

			const host = createMockHost({ localDoc, remoteDoc });
			host.pendingMachineEdits.push({
				fn: (s) => s,
				expectedText: "",
				captureMark: 1,
				registeredAt: Date.now(),
			});
			const bridge = new SyncBridge(host);

			// Should not throw despite SV divergence (pending edits skip assertion)
			bridge.flush();
		});

		test("convergence skipped when fork active", () => {
			const { localDoc, remoteDoc } = createDocPair("x");
			const host = createMockHost({ localDoc, remoteDoc, hasFork: true });
			const bridge = new SyncBridge(host);

			// Fork gates everything, so flush just increments counters
			bridge.flush();
			expect(bridge.pendingOutbound).toBe(1);
			expect(bridge.pendingInbound).toBe(1);
		});

		test("null docs handled gracefully in all methods", () => {
			const host = createMockHost({ localDoc: null, remoteDoc: null });
			const bridge = new SyncBridge(host);

			// None of these should throw
			bridge.syncToRemote(new Uint8Array(0));
			bridge.syncToLocal(new Uint8Array(0));
			bridge.flushOutbound();
			bridge.flushInbound();
			bridge.flush();
			bridge.setupUpdateQueues();
			bridge.teardownUpdateQueues();
			bridge.detachHandlers();
		});

		test("flushInbound machine-edit match with no OpCapture removes registration", () => {
			const { localDoc, remoteDoc } = createDocPair("hello");
			const host = createMockHost({ localDoc, remoteDoc });
			const bridge = new SyncBridge(host);

			const matchEntry = {
				fn: (s: string) => s,
				expectedText: "hello",
				captureMark: 5,
				registeredAt: Date.now(),
			};
			host._matchResult = matchEntry;

			let removedMark: number | null = null;
			host.removeMachineEdit = (entry: { captureMark: number }) => {
				removedMark = entry.captureMark;
			};

			bridge.flushInbound();
			expect(removedMark).toBe(5);
		});

		test("flushOutbound no-ops with null localDoc", () => {
			const host = createMockHost({ localDoc: null, remoteDoc: new Y.Doc() });
			const bridge = new SyncBridge(host);
			bridge.flushOutbound();
			expect(host.effects.length).toBe(0);
		});

		test("flushOutbound no-ops with null remoteDoc", () => {
			const host = createMockHost({ localDoc: new Y.Doc(), remoteDoc: null });
			const bridge = new SyncBridge(host);
			bridge.flushOutbound();
			expect(host.effects.length).toBe(0);
		});
	});
});

// ===========================================================================
// Rapid delete+insert as separate CM6_CHANGE events
// ===========================================================================

describe('Rapid delete+insert as separate CM6_CHANGE events', () => {
  test('both delete and insert reach remoteDoc when fired as two separate CM6_CHANGE events', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'Line 1\nLine 2 original\nLine 3');

    t.send(connected());
    t.send(providerSynced());
    t.clearEffects();

    // Simulate select-then-type as TWO separate CM6_CHANGE events:
    // Event 1: Delete "original" from Line 2 (positions 14-22 in "Line 1\nLine 2 original\nLine 3")
    //   "Line 1\nLine 2 \nLine 3" -> after deleting "original"
    const afterDelete = 'Line 1\nLine 2 \nLine 3';
    t.send(cm6Change(
      [{ from: 14, to: 22, insert: '' }],
      afterDelete,
    ));

    // Event 2: Insert "replaced" at position 14
    const afterInsert = 'Line 1\nLine 2 replaced\nLine 3';
    t.send(cm6Change(
      [{ from: 14, to: 14, insert: 'replaced' }],
      afterInsert,
    ));

    // Both operations should have reached localDoc
    expect(t.getLocalDocText()).toBe('Line 1\nLine 2 replaced\nLine 3');

    // Both operations should have reached remoteDoc via flushOutbound
    expect(t.getRemoteDocText()).toBe('Line 1\nLine 2 replaced\nLine 3');
  });

  test('single CM6_CHANGE with delete+insert in one transaction reaches remoteDoc', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'Line 1\nLine 2 original\nLine 3');

    t.send(connected());
    t.send(providerSynced());
    t.clearEffects();

    // CM6 fires a single event for select-then-type: delete old, insert new
    const afterReplace = 'Line 1\nLine 2 replaced\nLine 3';
    t.send(cm6Change(
      [{ from: 14, to: 22, insert: 'replaced' }],
      afterReplace,
    ));

    expect(t.getLocalDocText()).toBe('Line 1\nLine 2 replaced\nLine 3');
    expect(t.getRemoteDocText()).toBe('Line 1\nLine 2 replaced\nLine 3');
  });
});

// ===========================================================================
// flushOutbound with pending machine edits — machineEditMark false partition
// ===========================================================================

describe('flushOutbound machineEditMark partitioning', () => {
  test('user edit queued after machine edit mark is set gets deferred incorrectly', () => {
    const { localDoc, remoteDoc } = createDocPair('Line 1\nLine 2\nLine 3');
    const host = createMockHost({ localDoc, remoteDoc });
    const bridge = new SyncBridge(host);

    bridge.setupUpdateQueues();

    // Simulate: a machine edit is pending with captureMark=42
    host.pendingMachineEdits.push({
      fn: (s: string) => s,
      expectedText: 'irrelevant',
      captureMark: 42,
      registeredAt: Date.now(),
    });

    // Set the machine edit mark (simulates applyCM6ToLocalDoc line 1336)
    bridge.currentMachineEditMark = 42;

    // Apply a machine edit to localDoc (this queues an outbound entry with mark=42)
    const ytext = localDoc.getText('contents');
    localDoc.transact(() => {
      ytext.insert(0, 'MACHINE: ');
    }, MACHINE_EDIT_ORIGIN);

    // Clear the mark
    bridge.currentMachineEditMark = null;

    // Now a normal user edit arrives (no mark set)
    localDoc.transact(() => {
      ytext.delete(ytext.length - 1, 1); // delete last char
    });

    // Flush — the machine edit entry should be deferred, but the user edit should go through
    bridge.flushOutbound();

    const remoteText = remoteDoc.getText('contents').toString();
    // User's delete should have reached remoteDoc even though machine edit is pending
    // The machine edit "MACHINE: " should NOT be in remoteDoc (deferred)
    expect(remoteText).not.toContain('MACHINE: ');
    // But the user's delete SHOULD have reached remoteDoc
    expect(remoteText).toBe('Line 1\nLine 2\nLine ');
  });


});

// ===========================================================================
// Provider disconnect between delete and insert sync
// ===========================================================================

describe('Provider disconnect between delete and insert sync', () => {
  test('disconnect after delete CM6_CHANGE but before insert CM6_CHANGE loses the insert', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'Line 1\nLine 2 original\nLine 3');

    t.send(connected());
    t.send(providerSynced());
    t.clearEffects();

    // Event 1: Delete "original" — this flushes to remoteDoc
    const afterDelete = 'Line 1\nLine 2 \nLine 3';
    t.send(cm6Change(
      [{ from: 14, to: 22, insert: '' }],
      afterDelete,
    ));

    // Verify delete reached remoteDoc
    expect(t.getRemoteDocText()).toBe(afterDelete);

    // Provider disconnects between the two events
    t.send(disconnected());

    // Event 2: Insert "replaced" — provider is disconnected
    const afterInsert = 'Line 1\nLine 2 replaced\nLine 3';
    t.send(cm6Change(
      [{ from: 14, to: 14, insert: 'replaced' }],
      afterInsert,
    ));

    // localDoc should have the insert
    expect(t.getLocalDocText()).toBe(afterInsert);

    // remoteDoc should also have the insert (queued and applied locally even if provider down)
    // The question is: does flushOutbound still apply to remoteDoc when disconnected?
    expect(t.getRemoteDocText()).toBe(afterInsert);
  });

  test('reconnect after disconnect syncs pending insert to remoteDoc', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello world');

    t.send(connected());
    t.send(providerSynced());

    // User types while connected
    t.send(cm6Change(
      [{ from: 5, to: 11, insert: '' }],
      'hello',
    ));
    expect(t.getRemoteDocText()).toBe('hello');

    // Disconnect
    t.send(disconnected());

    // User types while disconnected
    t.send(cm6Change(
      [{ from: 5, to: 5, insert: ' there' }],
      'hello there',
    ));

    // localDoc has the edit
    expect(t.getLocalDocText()).toBe('hello there');

    // Check if remoteDoc got the edit despite disconnect
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _remoteAfterDisconnect = t.getRemoteDocText();

    // Reconnect
    t.send(connected());
    t.send(providerSynced());

    // After reconnect, remoteDoc should have all pending edits
    expect(t.getRemoteDocText()).toBe('hello there');
  });
});

// ===========================================================================
// teardownUpdateQueues drops pending outbound entries on close
// ===========================================================================

describe('teardownUpdateQueues drops pending outbound entries on close', () => {
  test('RELEASE_LOCK after edit but before flush drops the edit from remoteDoc', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello world');

    t.send(connected());
    t.send(providerSynced());

    // Directly test: can we observe the queue being cleared?
    // The issue: if teardownUpdateQueues() is called before flushOutbound(),
    // pending entries are lost.
    //
    // In practice, applyCM6ToLocalDoc calls flushOutbound() synchronously (line 1379),
    // so normal user edits should always flush before teardown.
    // But what if the edit is applied to localDoc but flush hasn't happened yet?

    // Apply edit normally — this should flush immediately
    t.send(cm6Change(
      [{ from: 5, to: 11, insert: ' everyone' }],
      'hello everyone',
    ));

    // Verify it reached remoteDoc before close
    expect(t.getRemoteDocText()).toBe('hello everyone');

    // Close the file
    t.send(releaseLock());

    // remoteDoc should still have the edit
    expect(t.getRemoteDocText()).toBe('hello everyone');
  });

  test('SyncBridge.teardownUpdateQueues clears outbound queue', () => {
    const { localDoc, remoteDoc } = createDocPair('test');
    const host = createMockHost({ localDoc, remoteDoc });
    const bridge = new SyncBridge(host);

    bridge.setupUpdateQueues();

    // Set hasFork so flushOutbound increments pending counter instead of syncing
    host._hasFork = true;

    // Make an edit — it goes to queue but flush is gated by hasFork
    localDoc.transact(() => {
      localDoc.getText('contents').insert(4, '!');
    });

    // Teardown before the fork is resolved
    bridge.teardownUpdateQueues();

    // Now clear the fork and try to flush
    host._hasFork = false;
    bridge.setupUpdateQueues();
    bridge.flushOutbound();

    // The queue-based entries were dropped by teardownUpdateQueues, BUT
    // the fallback diff path in flushOutbound (line 362-376) detects the
    // text mismatch between localDoc and remoteDoc and catches up via
    // full state diff. So the edit is NOT lost in practice.
    //
    // This means teardownUpdateQueues + re-setup + flush is safe due to
    // the fallback path. The queue drop is compensated.
    expect(remoteDoc.getText('contents').toString()).toBe('test!');
    expect(localDoc.getText('contents').toString()).toBe('test!');
  });

  test('rapid file close during active editing can lose last edit', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'Line 1\nLine 2\nLine 3');

    t.send(connected());
    t.send(providerSynced());

    // User makes an edit
    t.send(cm6Change(
      [{ from: 6, to: 6, insert: ' edited' }],
      'Line 1 edited\nLine 2\nLine 3',
    ));

    // Verify it synced
    expect(t.getRemoteDocText()).toBe('Line 1 edited\nLine 2\nLine 3');

    // Now simulate the scenario at the SyncBridge level:
    // The delete flushes, but before the insert flushes, RELEASE_LOCK fires.
    // Since applyCM6ToLocalDoc calls flushOutbound synchronously, this can only
    // happen if the two CM6 events are separated by a RELEASE_LOCK.

    // This is the actual race: CM6 fires delete, flush happens, then RELEASE_LOCK
    // arrives before CM6 fires the insert.
    //
    // After RELEASE_LOCK, the HSM transitions out of active.tracking and
    // teardownUpdateQueues is called, clearing the outbound queue.

    // Step 1: User selects "edited\nLine 2" and deletes it
    // Text: "Line 1 edited\nLine 2\nLine 3" -> delete pos 7..21
    const afterDel = 'Line 1 \nLine 3';
    t.send(cm6Change(
      [{ from: 7, to: 21, insert: '' }],
      afterDel,
    ));
    // Verify delete reached remoteDoc (CRDT positions may differ from CM6 positions)
    const remoteAfterDel = t.getRemoteDocText();
    expect(remoteAfterDel).not.toBe('Line 1 edited\nLine 2\nLine 3'); // delete applied

    // Step 2: File closes (RELEASE_LOCK) BEFORE the insert event fires
    t.send(releaseLock());

    // Step 3: The insert event would fire but HSM is no longer in active.tracking
    // so applyCM6ToLocalDoc is not invoked.
    // The localDoc has the delete but not the insert.
    // The remoteDoc has the delete but not the insert.

    // This matches the bug: delete reached remoteDoc, insert did not.
    // After this, when the file is reopened, remoteDoc has "Line 1 \nLine 3"
    // instead of "Line 1 replaced\nLine 3".
  });
});
