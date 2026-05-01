"use strict";

import { Observable } from "src/observable/Observable";
import { PostOffice } from "src/observable/Postie";
import type { TimeProvider } from "src/TimeProvider";

class TestObservable extends Observable<TestObservable> {
	emit(): void {
		this.notifyListeners();
	}
}

class TestTimeProvider implements TimeProvider {
	private pendingCallbacks: Array<() => void> = [];

	now(): number {
		return Date.now();
	}

	setTimeout(callback: () => void, _ms: number): number {
		this.pendingCallbacks.push(callback);
		return this.pendingCallbacks.length;
	}

	clearTimeout(_timerId: number): void {}

	setInterval(_callback: () => void, _ms: number): number {
		return 0;
	}

	clearInterval(_timerId: number): void {}

	destroy(): void {
		this.pendingCallbacks = [];
	}

	debounce<T extends (...args: any[]) => void>(
		func: T,
		_delay?: number,
	): (...args: Parameters<T>) => void {
		return func;
	}

	flush(): void {
		const callbacks = [...this.pendingCallbacks];
		this.pendingCallbacks = [];
		for (const callback of callbacks) {
			callback();
		}
	}
}

describe("Observable", () => {
	afterEach(() => {
		PostOffice._resetForTesting();
	});

	it("synchronously sends the current value through PostOffice when no PostOffice exists", () => {
		PostOffice._resetForTesting();
		const observable = new TestObservable("test");
		const subscriber = jest.fn();

		observable.subscribe(subscriber);

		expect(subscriber).toHaveBeenCalledTimes(1);
		expect(subscriber).toHaveBeenCalledWith(observable);
		expect(PostOffice.peekInstance()).not.toBeNull();
	});

	it("does not replay synchronous subscription delivery through PostOffice", () => {
		const timeProvider = new TestTimeProvider();
		PostOffice._resetForTesting(timeProvider);
		const firstObservable = new TestObservable("first");
		const secondObservable = new TestObservable("second");
		const firstSubscriber = jest.fn();
		const secondSubscriber = jest.fn();

		firstObservable.subscribe(firstSubscriber);
		secondObservable.subscribe(secondSubscriber);
		firstSubscriber.mockClear();
		secondSubscriber.mockClear();

		secondObservable.emit();
		timeProvider.flush();

		expect(firstSubscriber).not.toHaveBeenCalled();
		expect(secondSubscriber).toHaveBeenCalledTimes(1);
	});

	it("does not deliver subscription values after PostOffice is destroyed", () => {
		PostOffice.destroy();
		const observable = new TestObservable("test");
		const subscriber = jest.fn();

		observable.subscribe(subscriber);

		expect(subscriber).not.toHaveBeenCalled();
		expect(PostOffice.peekInstance()).toBeNull();
	});

	it("notifies subscribers through PostOffice during an active lifecycle", () => {
		const timeProvider = new TestTimeProvider();
		PostOffice._resetForTesting(timeProvider);
		const observable = new TestObservable("test");
		const subscriber = jest.fn();
		observable.subscribe(subscriber);
		subscriber.mockClear();

		observable.emit();
		timeProvider.flush();

		expect(subscriber).toHaveBeenCalledTimes(1);
		expect(subscriber).toHaveBeenCalledWith(observable);
	});

	it("drops late notifications after PostOffice is destroyed", () => {
		const observable = new TestObservable("test");
		const subscriber = jest.fn();
		observable.subscribe(subscriber);
		subscriber.mockClear();
		PostOffice.destroy();

		observable.emit();

		expect(subscriber).not.toHaveBeenCalled();
	});
});
