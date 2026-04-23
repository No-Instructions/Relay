import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";

describe("YSweetProvider", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.runOnlyPendingTimers();
		jest.useRealTimers();
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
});
