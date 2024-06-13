import { TokenStore } from "../src/TokenStore";
import type { TimeProvider } from "../src/TokenStore";
import { describe, expect, test } from "@jest/globals";

class TestTimeProvider implements TimeProvider {
	private currentTime: number;
	private timers: Array<{
		id: number;
		callback: () => void;
		triggerTime: number;
	}> = [];
	private nextTimerId = 0;

	constructor() {
		this.currentTime = Date.now();
	}

	getTime(): number {
		return this.currentTime;
	}

	setTime(newTime: number): void {
		const diff = (newTime - this.currentTime) / 1000;
		console.log(`setting time to ${newTime} (+${diff}s)`);
		this.currentTime = newTime;
		this.checkTimers();
	}

	//setInterval(callback: () => void, ms: number): NodeJS.Timer {
	//	const triggerTime = this.currentTime + ms;
	//	const timerId = setTimeout(() => callback(), ms);
	//	this.timers.push({ id: timerId, callback, triggerTime });
	//	return timerId;
	//}

	setInterval(callback: () => void, ms: number): NodeJS.Timer {
		return this.setTimeout(callback, ms, true);
	}

	clearInterval(timerId: NodeJS.Timer): void {
		const id = <number>(<unknown>timerId);
		this.timers = this.timers.filter((timer) => timer.id !== id);
	}

	setTimeout(
		callback: () => void,
		ms: number,
		isInterval = false
	): NodeJS.Timer {
		const triggerTime = this.currentTime + ms;
		const timerId = this.nextTimerId++;
		const timer = { id: timerId, callback, triggerTime };
		this.timers.push(timer);
		if (isInterval) {
			// If it's an interval, we immediately schedule the next execution
			const index = this.timers.length - 1;
			this.timers[index].callback = () => {
				callback();
				this.setTimeout(callback, ms, true); // Reschedule next execution
			};
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return <any>timerId;
	}

	//clearInterval(timerId: TimerID): void {
	//	this.timers = this.timers.filter((timer) => timer.id !== timerId);
	//	clearTimeout(timerId);
	//}

	//setTimeout(callback: () => void, ms: number): TimerID {
	//	const triggerTime = this.currentTime + ms;
	//	const timerId = { id: this.nextTimerId++ }; // Use an object as the ID to ensure uniqueness and avoid conflicts
	//	this.timers.push({ id: timerId, callback, triggerTime });
	//	return timerId;
	//}

	clearTimeout(timerId: NodeJS.Timer): void {
		const id = <number>(<unknown>timerId);
		this.timers = this.timers.filter((timer) => timer.id !== id);
	}

	private checkTimers(): void {
		console.log(this.timers);
		this.timers.forEach((timer) => {
			if (this.currentTime >= timer.triggerTime) {
				console.log("timer triggered");
				timer.callback();
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const id = <any>timer.id;
				this.clearInterval(id);
			}
		});
	}
}

interface TestToken {
	token: string;
}

async function _testTokenStore() {
	// Setup
	const testTimeProvider = new TestTimeProvider();
	console.log(testTimeProvider);
	const mockLog = (message: string) => console.log(`Log: ${message}`);
	const mockRefresh = (
		documentId: string,
		callback: (newToken: TestToken) => void
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
		1
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
