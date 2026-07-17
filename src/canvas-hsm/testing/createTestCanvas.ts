/**
 * Canvas world harness for unit tests.
 *
 * One vault is the full canvas stack over simulated I/O: a bare Canvas
 * (real applyData/enrollLocal/export methods over a real localDoc), a real
 * remoteDoc wired through the real CanvasDocBridge, a CanvasHSM whose
 * effects execute against a simulated disk the way the host does, and a
 * captured effect log. A world is two vaults whose remoteDocs relay
 * through a server Y.Doc, so tests can assert full-representation
 * convergence: disk == localDoc == remoteDoc per vault, localDocs equal
 * across vaults, and the server's own copy equal to both.
 *
 * Test files must mock the modules Canvas pulls in ("obsidian",
 * "../src/SharedFolder", "../src/storage/y-indexeddb", "../src/LoginManager",
 * "../src/LiveTokenStore", "../src/client/provider") before importing this
 * harness — see __tests__/canvas-hsm/cross-vault.test.ts.
 */

import * as Y from "yjs";
import { Canvas } from "../../Canvas";
import { formatCanvasData } from "../../CanvasData";
import type { CanvasData } from "../../CanvasView";
import { snapshotFromDoc } from "../../merge-hsm/state-vectors";
import type { PersistedCanvasState } from "../../merge-hsm/types";
import { CANVAS_BRIDGE_IN_ORIGIN, CanvasDocBridge } from "../bridge";
import { CanvasHSM } from "../CanvasHSM";
import type { CanvasEffect } from "../types";

export interface SimulatedDisk {
	/** null models an absent file. */
	contents: string | null;
	mtime: number;
}

export interface TestCanvasVault {
	name: string;
	canvas: Canvas;
	localDoc: Y.Doc;
	remoteDoc: Y.Doc;
	bridge: CanvasDocBridge;
	hsm: CanvasHSM;
	disk: SimulatedDisk;
	effects: CanvasEffect[];
	persistedRecords: PersistedCanvasState[];
	downloadRequests: number;
	member: boolean;
	/**
	 * Model the host's LOCAL_DOC_CHANGED debounce (Canvas.scheduleDocChanged
	 * coalesces doc changes for 1000ms): while true, doc changes buffer
	 * instead of reaching the machine, until deliverDocChanged() fires the
	 * coalesced event the way the host's timer would.
	 */
	deferDocChanged: boolean;
	/** The buffered doc-change reaches the machine (the debounce firing). */
	deliverDocChanged(): void;
	/** Send PERSISTENCE_LOADED and drain the first evaluation. */
	load(state?: PersistedCanvasState | null): Promise<void>;
	/** External process writes the file; the host reports DISK_CHANGED. */
	writeDisk(contents: string): Promise<void>;
	/** A view save: real Canvas.applyData into the localDoc. */
	applyView(data: CanvasData): Promise<void>;
	/** First-upload enrollment: real Canvas.enrollLocal of the disk file. */
	enroll(): Promise<void>;
	exportLocal(): CanvasData;
	exportRemote(): CanvasData;
	/** Parse the simulated disk file; null when absent. */
	parseDisk(): CanvasData | null;
	settle(): Promise<void>;
	destroy(): void;
}

export interface TestCanvasWorld {
	vaultA: TestCanvasVault;
	vaultB: TestCanvasVault;
	server: Y.Doc;
	/** Relay state-vector diffs remoteDoc↔server in both directions. */
	sync(): Promise<void>;
	exportServer(): CanvasData;
	destroy(): void;
}

/** Drain evaluate invokes and doc-change fanout. */
async function drain(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

let clock = 1000;

function bareCanvas(guid: string, path: string, localDoc: Y.Doc): Canvas {
	const canvas = Object.create(Canvas.prototype) as Canvas;
	Object.assign(canvas, {
		guid,
		path,
		destroyed: false,
		_materialized: true,
		_materialUnsubs: [],
		_localDoc: localDoc,
	});
	return canvas;
}

export function createTestCanvasVault(
	name: string,
	options: { guid?: string; path?: string } = {},
): TestCanvasVault {
	const guid = options.guid ?? "canvas-guid";
	const path = options.path ?? "board.canvas";
	const localDoc = new Y.Doc();
	const remoteDoc = new Y.Doc();
	const canvas = bareCanvas(guid, path, localDoc);
	const disk: SimulatedDisk = { contents: null, mtime: 0 };
	const effects: CanvasEffect[] = [];
	const persistedRecords: PersistedCanvasState[] = [];
	/** Coalesced buffered doc-change origin, latest-wins like the host. */
	let pendingDocChanged: "bridge" | "unknown" | null = null;

	const vault: TestCanvasVault = {
		name,
		canvas,
		localDoc,
		remoteDoc,
		bridge: null as unknown as CanvasDocBridge,
		hsm: null as unknown as CanvasHSM,
		disk,
		effects,
		persistedRecords,
		downloadRequests: 0,
		member: true,
		deferDocChanged: false,
		deliverDocChanged() {
			if (pendingDocChanged === null) return;
			const origin = pendingDocChanged;
			pendingDocChanged = null;
			vault.hsm.send({ type: "LOCAL_DOC_CHANGED", origin });
		},
		async load(state = null) {
			vault.hsm.send({ type: "PERSISTENCE_LOADED", state });
			await drain();
		},
		async writeDisk(contents: string) {
			disk.contents = contents;
			disk.mtime = ++clock;
			vault.hsm.send({ type: "DISK_CHANGED" });
			await drain();
		},
		async applyView(data: CanvasData) {
			await canvas.applyData(data);
			await drain();
		},
		async enroll() {
			await canvas.enrollLocal(disk.contents ?? "");
			await drain();
		},
		exportLocal: () => Canvas.exportCanvasData(localDoc),
		exportRemote: () => Canvas.exportCanvasData(remoteDoc),
		parseDisk() {
			if (disk.contents === null) return null;
			const raw = disk.contents.trim();
			const parsed = raw.length > 0 ? JSON.parse(raw) : {};
			return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
		},
		settle: drain,
		destroy() {
			vault.hsm.destroy();
			vault.bridge.destroy();
			localDoc.destroy();
			remoteDoc.destroy();
		},
	};

	const executeEffect = (effect: CanvasEffect) => {
		switch (effect.type) {
			case "WRITE_DISK": {
				disk.contents = effect.contents;
				disk.mtime = ++clock;
				vault.hsm.send({
					type: "FLUSH_COMPLETE",
					contents: effect.contents,
					hash: effect.hash,
					mtime: disk.mtime,
				});
				return;
			}
			case "INGEST_MERGE": {
				// Mirrors Canvas.executeEffect: the merge applies only while
				// the localDoc still exports the `ours` it was computed
				// from; otherwise abort, deliver the pending doc-change (the
				// host fires its debounce timer early), and report failure
				// so the machine re-evaluates against the live doc.
				let applied = false;
				try {
					applied = canvas.applyMerge(effect);
				} catch (e) {
					vault.hsm.send({ type: "FLUSH_FAILED", error: e });
					return;
				}
				if (!applied) {
					vault.deliverDocChanged();
					vault.hsm.send({ type: "FLUSH_FAILED" });
					return;
				}
				disk.contents = effect.contents;
				disk.mtime = ++clock;
				vault.hsm.send({
					type: "FLUSH_COMPLETE",
					contents: effect.contents,
					hash: effect.hash,
					mtime: disk.mtime,
				});
				return;
			}
			case "PERSIST_STATE":
				persistedRecords.push(effect.state);
				return;
			case "ENQUEUE_DOWNLOAD":
				vault.downloadRequests++;
				return;
			default:
				return;
		}
	};

	vault.hsm = new CanvasHSM({
		guid,
		folderGuid: "folder-guid",
		getPath: () => path,
		isMember: () => vault.member,
		readDisk: async () =>
			disk.contents === null
				? null
				: { contents: disk.contents, mtime: disk.mtime },
		exportData: () => Canvas.exportCanvasData(localDoc),
		formatData: formatCanvasData,
		getLocalSnapshot: () => snapshotFromDoc(localDoc).snapshot,
		hashFn: async (contents: string) => `h(${contents})`,
		now: () => ++clock,
		onEffect: (effect) => {
			effects.push(effect);
			executeEffect(effect);
		},
	});

	vault.bridge = new CanvasDocBridge(localDoc, remoteDoc, {});

	localDoc.on("update", (_update: Uint8Array, origin: unknown) => {
		const kind =
			origin === CANVAS_BRIDGE_IN_ORIGIN ? "bridge" : ("unknown" as const);
		if (vault.deferDocChanged) {
			pendingDocChanged = kind;
			return;
		}
		vault.hsm.send({ type: "LOCAL_DOC_CHANGED", origin: kind });
	});

	return vault;
}

export function createTestCanvasWorld(
	options: { guid?: string; path?: string } = {},
): TestCanvasWorld {
	const vaultA = createTestCanvasVault("vaultA", options);
	const vaultB = createTestCanvasVault("vaultB", options);
	const server = new Y.Doc();

	const relay = (from: Y.Doc, to: Y.Doc, origin: string) => {
		const diff = Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
		if (diff.length > 2) {
			Y.applyUpdate(to, diff, origin);
		}
	};

	return {
		vaultA,
		vaultB,
		server,
		async sync() {
			// Two rounds so content that reaches the server in round one
			// lands on the other vault's remoteDoc (and, through the
			// bridge, its localDoc) in the same call.
			for (let round = 0; round < 2; round++) {
				relay(vaultA.remoteDoc, server, "relay:test-server");
				relay(vaultB.remoteDoc, server, "relay:test-server");
				relay(server, vaultA.remoteDoc, "relay:test-server");
				relay(server, vaultB.remoteDoc, "relay:test-server");
			}
			await drain();
		},
		exportServer: () => Canvas.exportCanvasData(server),
		destroy() {
			vaultA.destroy();
			vaultB.destroy();
			server.destroy();
		},
	};
}
