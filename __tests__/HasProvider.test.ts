jest.mock("../src/LoginManager", () => ({
	LoginManager: class MockLoginManager {},
}));

jest.mock("../src/LiveTokenStore", () => ({
	LiveTokenStore: class MockLiveTokenStore {},
}));

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
});
