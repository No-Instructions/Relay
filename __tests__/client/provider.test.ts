import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";

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
});
