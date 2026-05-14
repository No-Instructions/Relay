jest.mock("../src/LoginManager", () => ({
	LoginManager: class MockLoginManager {},
}));

jest.mock("../src/LiveTokenStore", () => ({
	LiveTokenStore: class MockLiveTokenStore {},
}));

import * as Y from "yjs";
import { HasProvider } from "../src/HasProvider";

describe("HasProvider", () => {
	test("disconnect clears stale synced state", () => {
		const tokenStore = {
			getTokenSync: () => ({ token: "", url: "", docId: "-", expiryTime: 0 }),
			removeFromRefreshQueue: jest.fn(),
		};
		const loginManager = { user: null };

		const provider = new HasProvider(
			"guid-1",
			{} as any,
			tokenStore as any,
			loginManager as any,
		) as any;

		const disconnect = jest.fn();
		provider._provider = { disconnect } as any;
		provider._providerSynced = true;

		expect(provider.synced).toBe(true);

		provider.disconnect();

		expect(disconnect).toHaveBeenCalled();
		expect(provider.synced).toBe(false);
		expect(tokenStore.removeFromRefreshQueue).toHaveBeenCalledWith("guid-1");
	});

	test("onceConnected resolves when provider is already connected", async () => {
		const tokenStore = {
			getTokenSync: () => ({ token: "", url: "", docId: "-", expiryTime: 0 }),
			removeFromRefreshQueue: jest.fn(),
		};
		const loginManager = { user: null };

		const provider = new HasProvider(
			"guid-1",
			{} as any,
			tokenStore as any,
			loginManager as any,
		) as any;

		provider._ydoc = new Y.Doc();
		provider._provider = {
			connectionState: { status: "connected" },
			on: jest.fn(),
			off: jest.fn(),
		};

		await expect(provider.onceConnected()).resolves.toBeUndefined();
		expect(provider._provider.on).not.toHaveBeenCalled();
	});

	test("onceProviderSynced waits for a true synced event", async () => {
		const tokenStore = {
			getTokenSync: () => ({ token: "", url: "", docId: "-", expiryTime: 0 }),
			removeFromRefreshQueue: jest.fn(),
		};
		const loginManager = { user: null };

		const provider = new HasProvider(
			"guid-1",
			{} as any,
			tokenStore as any,
			loginManager as any,
		) as any;

		let syncedHandler: ((synced: boolean) => void) | null = null;
		provider._ydoc = new Y.Doc();
		provider._provider = {
			synced: false,
			connectionState: { status: "connecting", intent: "connected" },
			canReconnect: () => true,
			on: jest.fn((_event: string, cb: (synced: boolean) => void) => {
				if (_event === "synced") {
					syncedHandler = cb;
				}
			}),
			off: jest.fn(),
		};

		let resolved = false;
		const syncedPromise = provider.onceProviderSynced().then(() => {
			resolved = true;
		});

		expect(provider._provider.on).toHaveBeenCalledWith("synced", expect.any(Function));

		syncedHandler?.(false);
		await Promise.resolve();
		expect(resolved).toBe(false);

		syncedHandler?.(true);
		await syncedPromise;
		expect(resolved).toBe(true);
		expect(provider.synced).toBe(true);
		expect(provider._provider.off).toHaveBeenCalledWith("synced", syncedHandler);
	});

	test("onceProviderSynced resolves immediately when provider already synced", async () => {
		const tokenStore = {
			getTokenSync: () => ({ token: "", url: "", docId: "-", expiryTime: 0 }),
			removeFromRefreshQueue: jest.fn(),
		};
		const loginManager = { user: null };

		const provider = new HasProvider(
			"guid-1",
			{} as any,
			tokenStore as any,
			loginManager as any,
		) as any;

		provider._ydoc = new Y.Doc();
		provider._provider = {
			synced: true,
			on: jest.fn(),
			off: jest.fn(),
		};

		await expect(provider.onceProviderSynced()).resolves.toBeUndefined();
		expect(provider.synced).toBe(true);
		expect(provider._provider.on).not.toHaveBeenCalled();
	});

	test("onceProviderSynced rejects when provider cannot keep trying", async () => {
		const tokenStore = {
			getTokenSync: () => ({ token: "", url: "", docId: "-", expiryTime: 0 }),
			removeFromRefreshQueue: jest.fn(),
		};
		const loginManager = { user: null };

		const provider = new HasProvider(
			"guid-1",
			{} as any,
			tokenStore as any,
			loginManager as any,
		) as any;

		provider._ydoc = new Y.Doc();
		provider._provider = {
			synced: false,
			connectionState: { status: "disconnected", intent: "connected" },
			canReconnect: () => false,
			on: jest.fn(),
			off: jest.fn(),
		};

		await expect(provider.onceProviderSynced()).rejects.toThrow(
			"Provider retries were exhausted before sync completed",
		);
	});

	test("disconnect rejects pending provider sync waiters", async () => {
		const tokenStore = {
			getTokenSync: () => ({ token: "", url: "", docId: "-", expiryTime: 0 }),
			removeFromRefreshQueue: jest.fn(),
		};
		const loginManager = { user: null };

		const provider = new HasProvider(
			"guid-1",
			{} as any,
			tokenStore as any,
			loginManager as any,
		) as any;

		provider._ydoc = new Y.Doc();
		provider._provider = {
			synced: false,
			connectionState: { status: "connecting", intent: "connected" },
			canReconnect: () => true,
			disconnect: jest.fn(),
			on: jest.fn(),
			off: jest.fn(),
		};

		const wait = provider.onceProviderSynced();
		provider.disconnect();

		await expect(wait).rejects.toThrow(
			"Provider disconnected before sync completed",
		);
	});

	test("connection errors leave provider retry/backoff in charge", async () => {
		const token = {
			token: "token",
			url: "ws://example.com",
			docId: "room",
			expiryTime: Date.now() + 60_000,
		};
		const tokenStore = {
			getTokenSync: () => token,
			getToken: jest.fn(() => Promise.resolve(token)),
			removeFromRefreshQueue: jest.fn(),
		};
		const loginManager = { user: null };

		const provider = new HasProvider(
			"guid-1",
			{} as any,
			tokenStore as any,
			loginManager as any,
		) as any;
		provider.ensureRemoteDoc();
		provider._provider.shouldConnect = true;

		const disconnectSpy = jest.spyOn(provider, "disconnect");
		const connectSpy = jest.spyOn(provider, "connect");

		provider._provider.emit("connection-error", [{} as Event, provider._provider]);
		await Promise.resolve();

		expect(disconnectSpy).not.toHaveBeenCalled();
		expect(connectSpy).not.toHaveBeenCalled();

		provider.destroy();
	});
});
