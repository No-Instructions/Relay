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
			on: jest.fn((_event: string, cb: (synced: boolean) => void) => {
				syncedHandler = cb;
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
