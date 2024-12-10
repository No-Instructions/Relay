import { TokenStore } from "../src/TokenStore";
import { MockTimeProvider } from "./mocks/MockTimeProvider";
import { describe, expect, test } from "@jest/globals";

interface TestToken {
	token: string;
}

async function _testTokenStore() {
	// Setup
	const testTimeProvider = new MockTimeProvider();
	console.log(testTimeProvider);
	const mockLog = (message: string) => console.log(`Log: ${message}`);
	const mockRefresh = (
		documentId: string,
		callback: (newToken: TestToken) => void,
	) => {
		testTimeProvider.setTimeout(() => {
			callback({
				token: (testTimeProvider.getTime() + 30 * 60 * 1000).toString(),
			});
		}, 100);
	};
	const _testGetJwtExpiry = (token: TestToken) => {
		return parseInt(token.token);
	};

	const tokenStore = new TokenStore<TestToken>(
		{
			log: mockLog,
			refresh: mockRefresh,
			getTimeProvider: () => testTimeProvider,
			getJwtExpiry: _testGetJwtExpiry,
		},
		1,
	);

	// Start the TokenStore processing
	tokenStore.start();

	// Add some tokens, some of which are close to expiry
	const tokenPromise = Promise.all([
		tokenStore.getToken("doc1", "/doc1.md", () => {
			console.log("doc 1 callback");
		}),
		tokenStore.getToken("doc2", "/doc2.md", () => {
			console.log("doc 2 callback");
		}),
	]);

	// Advance time for response to happen
	testTimeProvider.setTime(testTimeProvider.getTime() + 1000); // Advance time by 1 second

	await tokenPromise;

	tokenStore.log(tokenStore.report());

	// Advance time to trigger refresh of tokens close to expiry
	testTimeProvider.setTime(testTimeProvider.getTime() + 5 * 60 * 1000); // Advance time by 5 minutes
	tokenStore.log(tokenStore.report());

	testTimeProvider.setTime(testTimeProvider.getTime() + 20 * 60 * 1000); // Advance time by 20 minutes
	tokenStore.log(tokenStore.report());
	// Stop the TokenStore processing to clean up
	tokenStore.stop();

	testTimeProvider.setTime(testTimeProvider.getTime() + 1000); // Advance time by 1 second
	testTimeProvider.setTime(testTimeProvider.getTime() + 1000); // Advance time by 1 second
	tokenStore.log(tokenStore.report());

	tokenStore.clearState();

	tokenStore.log(tokenStore.report());
}

describe("token store", () => {
	test("simple test", async () => {
		await _testTokenStore();
		expect(true).toBe(true);
	});
});
