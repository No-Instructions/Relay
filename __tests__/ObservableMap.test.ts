"use strict";

import type { TimeProvider } from "src/TimeProvider";
import { ObservableMap } from "src/observable/ObservableMap";
import { PostOffice } from "src/observable/Postie";

/**
 * A synchronous TimeProvider for testing that executes callbacks immediately
 * or allows manual flushing.
 */
class TestTimeProvider implements TimeProvider {
	private pendingCallbacks: Array<{ id: number; callback: () => void }> = [];
	private nextId = 1;

	getTime(): number {
		return Date.now();
	}

	setTimeout(callback: () => void, _ms: number): number {
		const id = this.nextId++;
		this.pendingCallbacks.push({ id, callback });
		return id;
	}

	clearTimeout(timerId: number): void {
		this.pendingCallbacks = this.pendingCallbacks.filter((p) => p.id !== timerId);
	}

	setInterval(_callback: () => void, _ms: number): number {
		return this.nextId++;
	}

	clearInterval(_timerId: number): void {}

	destroy(): void {
		this.pendingCallbacks = [];
	}

	debounce<T extends (...args: any[]) => void>(
		func: T,
		_delay: number = 500,
	): (...args: Parameters<T>) => void {
		return func;
	}

	/** Flush all pending timeouts synchronously */
	flush(): void {
		// Flush once - don't follow reschedules to avoid infinite loops
		// PostOffice reschedules if mailboxes.size > 0, but size stays > 0
		// because deliver() only clears senders, not the mailbox entries
		const callbacks = [...this.pendingCallbacks];
		this.pendingCallbacks = [];
		for (const { callback } of callbacks) {
			callback();
		}
	}
}

describe("ObservableMap", () => {
	let timeProvider: TestTimeProvider;

	beforeEach(() => {
		timeProvider = new TestTimeProvider();
		PostOffice._resetForTesting(timeProvider);
	});

	afterEach(() => {
		PostOffice._resetForTesting();
	});

	/** Helper to flush pending PostOffice deliveries */
	function flushDeliveries() {
		timeProvider.flush();
	}

	describe("basic Map operations", () => {
		it("should set and get values", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			expect(map.get("a")).toBe(1);
			expect(map.get("b")).toBe(2);
			expect(map.get("c")).toBeUndefined();
		});

		it("should return correct size", () => {
			const map = new ObservableMap<string, number>();
			expect(map.size).toBe(0);

			map.set("a", 1);
			expect(map.size).toBe(1);

			map.set("b", 2);
			expect(map.size).toBe(2);

			map.set("a", 3); // overwrite
			expect(map.size).toBe(2);
		});

		it("should check if key exists with has()", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);

			expect(map.has("a")).toBe(true);
			expect(map.has("b")).toBe(false);
		});

		it("should delete values", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			expect(map.delete("a")).toBe(true);
			expect(map.has("a")).toBe(false);
			expect(map.size).toBe(1);

			expect(map.delete("nonexistent")).toBe(false);
		});

		it("should clear all values", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			map.clear();

			expect(map.size).toBe(0);
			expect(map.has("a")).toBe(false);
			expect(map.has("b")).toBe(false);
		});

		it("should return keys as array", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			expect(map.keys()).toEqual(["a", "b"]);
		});

		it("should return values as array", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			expect(map.values()).toEqual([1, 2]);
		});

		it("should return entries as array", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			expect(map.entries()).toEqual([
				["a", 1],
				["b", 2],
			]);
		});

		it("should iterate with forEach", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			const results: [string, number][] = [];
			map.forEach((value, key) => {
				results.push([key, value]);
			});

			expect(results).toEqual([
				["a", 1],
				["b", 2],
			]);
		});

		it("should find values with predicate", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);
			map.set("c", 3);

			expect(map.find((v) => v > 1)).toBe(2);
			expect(map.find((v) => v > 10)).toBeUndefined();
			expect(map.find((_, k) => k === "c")).toBe(3);
		});

		it("should check with some()", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			expect(map.some((v) => v > 1)).toBe(true);
			expect(map.some((v) => v > 10)).toBe(false);
		});
	});

	describe("subscribe/unsubscribe", () => {
		it("should call subscriber immediately on subscribe", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);

			const subscriber = jest.fn();
			map.subscribe(subscriber);

			// Immediate delivery happens synchronously
			expect(subscriber).toHaveBeenCalledTimes(1);
			expect(subscriber).toHaveBeenCalledWith(map);
		});

		it("should notify subscribers on set", () => {
			const map = new ObservableMap<string, number>();
			const subscriber = jest.fn();
			map.subscribe(subscriber);

			subscriber.mockClear();
			map.set("a", 1);

			// PostOffice uses setTimeout for batched delivery
			flushDeliveries();

			expect(subscriber).toHaveBeenCalledWith(map);
		});

		it("should notify subscribers on delete", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);

			const subscriber = jest.fn();
			map.subscribe(subscriber);
			subscriber.mockClear();

			map.delete("a");
			flushDeliveries();

			expect(subscriber).toHaveBeenCalledWith(map);
		});

		it("should not notify on delete of nonexistent key", () => {
			const map = new ObservableMap<string, number>();
			const subscriber = jest.fn();
			map.subscribe(subscriber);
			subscriber.mockClear();

			map.delete("nonexistent");
			flushDeliveries();

			expect(subscriber).not.toHaveBeenCalled();
		});

		it("should notify subscribers on clear", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);

			const subscriber = jest.fn();
			map.subscribe(subscriber);
			subscriber.mockClear();

			map.clear();
			flushDeliveries();

			expect(subscriber).toHaveBeenCalledWith(map);
		});

		it("should stop notifying after unsubscribe via returned function", () => {
			const map = new ObservableMap<string, number>();
			const subscriber = jest.fn();
			const unsubscribe = map.subscribe(subscriber);
			subscriber.mockClear();

			unsubscribe();
			map.set("a", 1);
			flushDeliveries();

			expect(subscriber).not.toHaveBeenCalled();
		});

		it("should stop notifying after unsubscribe via method", () => {
			const map = new ObservableMap<string, number>();
			const subscriber = jest.fn();
			map.subscribe(subscriber);
			subscriber.mockClear();

			map.unsubscribe(subscriber);
			map.set("a", 1);
			flushDeliveries();

			expect(subscriber).not.toHaveBeenCalled();
		});
	});

	describe("filter (DerivedMap)", () => {
		it("should create a filtered view of the map", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);
			map.set("c", 3);

			const predicate = (v: number) => v > 1;
			const filtered = map.filter(predicate);

			const subscriber = jest.fn();
			filtered.subscribe(subscriber);

			expect(filtered.size).toBe(2);
			expect(filtered.values()).toEqual([2, 3]);
		});

		it("should return same DerivedMap for same predicate function", () => {
			const map = new ObservableMap<string, number>();
			const predicate = (v: number) => v > 1;

			const filtered1 = map.filter(predicate);
			const filtered2 = map.filter(predicate);

			expect(filtered1).toBe(filtered2);
		});

		it("should return different DerivedMap for different predicate functions", () => {
			const map = new ObservableMap<string, number>();
			const predicate1 = (v: number) => v > 1;
			const predicate2 = (v: number) => v > 2;

			const filtered1 = map.filter(predicate1);
			const filtered2 = map.filter(predicate2);

			expect(filtered1).not.toBe(filtered2);
		});

		it("should update DerivedMap when parent changes", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			const filtered = map.filter((v) => v > 1);
			const subscriber = jest.fn();
			filtered.subscribe(subscriber);
			subscriber.mockClear();

			map.set("c", 3);
			flushDeliveries();

			expect(filtered.size).toBe(2);
			expect(filtered.values()).toEqual([2, 3]);
			expect(subscriber).toHaveBeenCalled();
		});

		it("should eagerly populate DerivedMap so .values() works without subscribing", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);
			map.set("c", 3);

			const filtered = map.filter((v) => v > 1);

			// This is the key behavior from the recent change:
			// .values() should work without subscribing
			expect(filtered.values()).toEqual([2, 3]);
			expect(filtered.size).toBe(2);
		});

		it("should allow accessing DerivedMap entries without subscribing", () => {
			const map = new ObservableMap<string, number>();
			map.set("x", 10);
			map.set("y", 20);
			map.set("z", 5);

			const filtered = map.filter((v) => v >= 10);

			// All read operations should work without subscribing
			expect(filtered.keys()).toEqual(["x", "y"]);
			expect(filtered.entries()).toEqual([
				["x", 10],
				["y", 20],
			]);
			expect(filtered.has("x")).toBe(true);
			expect(filtered.has("z")).toBe(false);
			expect(filtered.get("y")).toBe(20);
		});

		it("should cleanup DerivedMap when all subscribers unsubscribe", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			const predicate = (v: number) => v > 0;
			const filtered = map.filter(predicate);

			const subscriber1 = jest.fn();
			const subscriber2 = jest.fn();
			const unsub1 = filtered.subscribe(subscriber1);
			const unsub2 = filtered.subscribe(subscriber2);

			// Both unsubscribe
			unsub1();
			unsub2();

			// After cleanup, getting a new filter should work
			const filtered2 = map.filter(predicate);
			expect(filtered2.values()).toEqual([1, 2]);
		});

		it("should filter by key as well as value", () => {
			const map = new ObservableMap<string, number>();
			map.set("item-1", 100);
			map.set("item-2", 200);
			map.set("other-1", 300);

			const filtered = map.filter((_, key) => key.startsWith("item"));
			expect(filtered.size).toBe(2);
			expect(filtered.keys()).toEqual(["item-1", "item-2"]);
		});

		it("should handle empty parent map", () => {
			const map = new ObservableMap<string, number>();
			const filtered = map.filter((v) => v > 0);

			expect(filtered.size).toBe(0);
			expect(filtered.values()).toEqual([]);
		});

		it("should handle filter that matches nothing", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			const filtered = map.filter((v) => v > 100);

			expect(filtered.size).toBe(0);
			expect(filtered.values()).toEqual([]);
		});

		it("should reflect parent deletions in DerivedMap", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);
			map.set("c", 3);

			const filtered = map.filter((v) => v > 0);
			const subscriber = jest.fn();
			filtered.subscribe(subscriber);
			subscriber.mockClear();

			map.delete("b");
			flushDeliveries();

			expect(filtered.values()).toEqual([1, 3]);
		});

		it("should reflect parent clear in DerivedMap", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1);
			map.set("b", 2);

			const filtered = map.filter((v) => v > 0);
			const subscriber = jest.fn();
			filtered.subscribe(subscriber);
			subscriber.mockClear();

			map.clear();
			flushDeliveries();

			expect(filtered.size).toBe(0);
		});
	});

	describe("on/off listeners", () => {
		it("should support on() for simple change notifications", () => {
			const map = new ObservableMap<string, number>();
			const listener = jest.fn();
			map.on(listener);

			map.set("a", 1);
			flushDeliveries();

			expect(listener).toHaveBeenCalled();
		});

		it("should stop calling listener after off()", () => {
			const map = new ObservableMap<string, number>();
			const listener = jest.fn();
			map.on(listener);
			map.off(listener);

			map.set("a", 1);
			flushDeliveries();

			expect(listener).not.toHaveBeenCalled();
		});

		it("should return unsubscriber from on()", () => {
			const map = new ObservableMap<string, number>();
			const listener = jest.fn();
			const unsub = map.on(listener);

			unsub();
			map.set("a", 1);
			flushDeliveries();

			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("method chaining", () => {
		it("should allow chaining set calls", () => {
			const map = new ObservableMap<string, number>();
			map.set("a", 1).set("b", 2).set("c", 3);

			expect(map.size).toBe(3);
			expect(map.values()).toEqual([1, 2, 3]);
		});
	});

	describe("generic typing", () => {
		it("should work with complex value types", () => {
			interface User {
				name: string;
				age: number;
			}

			const map = new ObservableMap<string, User>();
			map.set("user1", { name: "Alice", age: 30 });
			map.set("user2", { name: "Bob", age: 25 });

			const adults = map.filter((user) => user.age >= 18);
			expect(adults.size).toBe(2);

			const found = map.find((user) => user.name === "Bob");
			expect(found?.age).toBe(25);
		});

		it("should support get with type parameter", () => {
			const map = new ObservableMap<string, unknown>();
			map.set("num", 42);
			map.set("str", "hello");

			const num = map.get<number>("num");
			expect(num).toBe(42);
		});
	});
});
