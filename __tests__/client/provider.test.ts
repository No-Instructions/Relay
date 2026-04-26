import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import {
	messageSync,
	messageQuerySubdocs,
	normalizeSubdocIndex,
	YSweetProvider,
} from "../../src/client/provider";

const RELAY_GUID = "8d6b60a2-3ed9-456d-9722-64ffaa17ac12";
const DOC_GUID_A = "d19f118d-1791-4c33-b933-9fce18677619";
const DOC_GUID_B = "1ad0450b-4bc1-4d42-969a-df8d10f7141e";
const DOC_GUID_C = "2c6c90c3-4bc9-4e3d-baa0-49727b0ed90f";
const DOC_GUID_D = "7015676d-b1af-4697-b6e8-241cae87e0ce";
const DOC_GUID_E = "f1257c45-17f8-4d0c-b564-8f92026c0b73";
const DOC_ID_A = `${RELAY_GUID}-${DOC_GUID_A}`;
const DOC_ID_B = `${RELAY_GUID}-${DOC_GUID_B}`;
const DOC_ID_C = `${RELAY_GUID}-${DOC_GUID_C}`;
const DOC_ID_D = `${RELAY_GUID}-${DOC_GUID_D}`;
const DOC_ID_E = `${RELAY_GUID}-${DOC_GUID_E}`;

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: FakeWebSocket[] = [];

	binaryType: BinaryType = "blob";
	readyState = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

	constructor(public url: string | URL) {
		FakeWebSocket.instances.push(this);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
		this.sent.push(data);
	}

	close() {
		if (this.readyState === FakeWebSocket.CLOSED) {
			return;
		}
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({} as CloseEvent);
	}

	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	receive(data: Uint8Array) {
		this.onmessage?.({ data: data.buffer } as MessageEvent);
	}

	fail() {
		this.onerror?.({} as Event);
		this.close();
	}
}

describe("YSweetProvider", () => {
	const originalWebSocket = global.WebSocket;

	beforeEach(() => {
		jest.useFakeTimers();
		FakeWebSocket.instances = [];
		(global as any).WebSocket = FakeWebSocket;
	});

	afterEach(() => {
		jest.runOnlyPendingTimers();
		jest.useRealTimers();
		(global as any).WebSocket = originalWebSocket;
	});

	test("disconnect clears synced and prevents stale synced fast-path", () => {
		const provider = new YSweetProvider("ws://example.com", "room", new Y.Doc(), {
			connect: false,
			disableBc: true,
		});

		provider.synced = true;
		provider.disconnect();

		expect(provider.synced).toBe(false);

		const syncedHandler = jest.fn();
		provider.once("synced", syncedHandler);
		jest.runOnlyPendingTimers();
		expect(syncedHandler).not.toHaveBeenCalled();

		provider.destroy();
	});

	test("connect does not bypass an already scheduled reconnect backoff", () => {
		const provider = new YSweetProvider("ws://example.com", "room", new Y.Doc(), {
			connect: false,
			disableBc: true,
			WebSocketPolyfill: FakeWebSocket as any,
			maxConnectionErrors: 3,
		});

		provider.connect();
		expect(FakeWebSocket.instances).toHaveLength(1);

		FakeWebSocket.instances[0].fail();
		expect(FakeWebSocket.instances).toHaveLength(1);

		provider.connect();
		expect(FakeWebSocket.instances).toHaveLength(1);

		jest.advanceTimersByTime(199);
		expect(FakeWebSocket.instances).toHaveLength(1);

		jest.advanceTimersByTime(1);
		expect(FakeWebSocket.instances).toHaveLength(2);

		provider.destroy();
	});

	test("read-only provider connects with sync step 1 but drops queued outbound updates", () => {
		const provider = new YSweetProvider("ws://example.com", "room", new Y.Doc(), {
			connect: false,
			disableBc: true,
			WebSocketPolyfill: FakeWebSocket as any,
			readOnly: true,
		});
		provider._pendingMessages.push(new Uint8Array([messageSync, 2, 1]).buffer);

		provider.connect();
		const ws = FakeWebSocket.instances[0];
		ws.open();

		expect(provider._pendingMessages).toHaveLength(0);
		expect(ws.sent).toHaveLength(1);
		const decoder = decoding.createDecoder(ws.sent[0] as Uint8Array);
		expect(decoding.readVarUint(decoder)).toBe(messageSync);
		expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep1);

		provider.destroy();
	});

	test("read-only provider applies inbound updates but does not send local document state", () => {
		const localDoc = new Y.Doc();
		const remoteDoc = new Y.Doc();
		remoteDoc.getText("contents").insert(0, "remote");
		const provider = new YSweetProvider("ws://example.com", "room", localDoc, {
			connect: false,
			disableBc: true,
			WebSocketPolyfill: FakeWebSocket as any,
			readOnly: true,
		});

		provider.connect();
		const ws = FakeWebSocket.instances[0];
		ws.open();
		ws.sent = [];

		const inboundStep2 = encoding.createEncoder();
		encoding.writeVarUint(inboundStep2, messageSync);
		syncProtocol.writeSyncStep2(inboundStep2, remoteDoc);
		ws.receive(encoding.toUint8Array(inboundStep2));

		expect(localDoc.getText("contents").toString()).toBe("remote");
		expect(ws.sent).toHaveLength(0);

		const serverStep1 = encoding.createEncoder();
		encoding.writeVarUint(serverStep1, messageSync);
		syncProtocol.writeSyncStep1(serverStep1, new Y.Doc());
		ws.receive(encoding.toUint8Array(serverStep1));

		expect(ws.sent).toHaveLength(0);

		localDoc.getText("contents").insert(6, " local");
		expect(ws.sent).toHaveLength(0);

		provider.destroy();
	});

	test("sendQuerySubdocs encodes full-index query as zero count", () => {
		const provider = new YSweetProvider("ws://example.com", "room", new Y.Doc(), {
			connect: false,
			disableBc: true,
		});
		const ws = new FakeWebSocket("ws://example.com/room");
		ws.readyState = FakeWebSocket.OPEN;
		provider.ws = ws as any;

		provider.sendQuerySubdocs();

		const decoder = decoding.createDecoder(ws.sent[0] as Uint8Array);
		expect(decoding.readVarUint(decoder)).toBe(messageQuerySubdocs);
		expect(decoding.readVarUint(decoder)).toBe(0);

		provider.destroy();
	});

	test("sendQuerySubdocs encodes selected server doc IDs", () => {
		const provider = new YSweetProvider("ws://example.com", "room", new Y.Doc(), {
			connect: false,
			disableBc: true,
		});
		const ws = new FakeWebSocket("ws://example.com/room");
		ws.readyState = FakeWebSocket.OPEN;
		provider.ws = ws as any;
		provider.getSubdocQueryDocIds = () => [
			DOC_ID_A,
			DOC_ID_A,
			DOC_ID_B,
		];

		provider.sendQuerySubdocs();

		const decoder = decoding.createDecoder(ws.sent[0] as Uint8Array);
		expect(decoding.readVarUint(decoder)).toBe(messageQuerySubdocs);
		expect(decoding.readVarUint(decoder)).toBe(2);
		expect(decoding.readVarString(decoder)).toBe(DOC_ID_A);
		expect(decoding.readVarString(decoder)).toBe(DOC_ID_B);

		provider.destroy();
	});

	test("normalizes legacy and metadata subdoc index entries", () => {
		const index = normalizeSubdocIndex({
			[DOC_ID_A]: new Uint8Array([1, 2]),
			[DOC_ID_B]: {
				state_vector: new Uint8Array([3, 4]),
				last_seen: "1710000000",
			},
			[DOC_ID_C]: {
				stateVector: new Uint8Array([5, 6]),
				lastSeen: "2026-04-24T19:31:39.593Z",
			},
			[DOC_ID_D]: {
				sv: new Uint8Array([7, 8]),
				last_seen: new Date("2026-04-24T19:32:00.000Z"),
			},
			[DOC_ID_E]: {},
		});

		expect(index[DOC_ID_A]).toEqual({
			stateVector: new Uint8Array([1, 2]),
		});
		expect(index[DOC_ID_B]).toEqual({
			stateVector: new Uint8Array([3, 4]),
			lastSeen: 1710000000,
		});
		expect(index[DOC_ID_C]).toEqual({
			stateVector: new Uint8Array([5, 6]),
			lastSeen: Date.parse("2026-04-24T19:31:39.593Z"),
		});
		expect(index[DOC_ID_D]).toEqual({
			stateVector: new Uint8Array([7, 8]),
			lastSeen: Date.parse("2026-04-24T19:32:00.000Z"),
		});
		expect(index[DOC_ID_E]).toBeUndefined();
	});

	test("handleSubdocIndex stores and notifies subdoc index listeners", () => {
		const provider = new YSweetProvider("ws://example.com", "room", new Y.Doc(), {
			connect: false,
			disableBc: true,
		});
		const observed: unknown[] = [];
		const index = {
			[DOC_ID_A]: {
				stateVector: new Uint8Array([1, 2]),
				lastSeen: 1710000000,
			},
		};

		const unsubscribe = provider.subscribeToSubdocIndex((serverIndex) => {
			observed.push(serverIndex);
		});
		provider.handleSubdocIndex(index);

		expect(provider.lastSubdocIndex).toBe(index);
		expect(observed).toEqual([index]);

		unsubscribe();
		provider.handleSubdocIndex(index);
		expect(observed).toHaveLength(1);

		provider.destroy();
	});
});
