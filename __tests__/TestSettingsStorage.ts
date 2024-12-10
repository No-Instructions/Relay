import {
	describe,
	test,
	expect,
	afterEach,
	beforeEach,
	jest,
} from "@jest/globals";
import type { Mock } from "jest-mock";
import { MockTimeProvider } from "./mocks/MockTimeProvider";
import {
	NamespacedSettings,
	Settings,
} from "../src/SettingsStorage";
import { PostOffice } from "../src/observable/Postie";

interface TestData {
	foo: string;
	count: number;
}

export class MemoryStorageAdapter<T> {
	private data: T | null = null;

	async loadData(): Promise<T | null> {
		return this.data;
	}

	async saveData(data: T): Promise<void> {
		this.data = data;
	}
}

describe("NamespacedSettings", () => {
	let mockTime: MockTimeProvider;
	let storage: MemoryStorageAdapter<Record<string, any>>;
	let settings: Settings<Record<string, any>>;
	let namespaced: NamespacedSettings<TestData>;
	let listener: Mock;

	const defaultValue: TestData = {
		foo: "default",
		count: 0,
	};

	beforeEach(() => {
		mockTime = new MockTimeProvider();
		PostOffice.destroy();
		// @ts-ignore - accessing private constructor for testing
		PostOffice["instance"] = new PostOffice(mockTime);
		PostOffice["_destroyed"] = false;

		storage = new MemoryStorageAdapter();
		settings = new Settings(storage, {});
		settings.load();
		namespaced = new NamespacedSettings(settings, "test/path", defaultValue);
		listener = jest.fn();
	});

	test("returns default value when path does not exist", () => {
		expect(namespaced.get()).toEqual(defaultValue);
	});

	test("sets and gets nested value", async () => {
		const testData: TestData = {
			foo: "bar",
			count: 42,
		};

		await namespaced.set(testData);
		mockTime.setTime(mockTime.getTime() + 30);

		expect(namespaced.get()).toEqual(testData);
		expect(settings.get()).toEqual({
			test: {
				path: testData,
			},
		});
	});

	test("handles multiple nested paths", async () => {
		const path1 = new NamespacedSettings(settings, "a/b/c", defaultValue);
		const path2 = new NamespacedSettings(settings, "a/b/d", defaultValue);

		await path1.set({ foo: "path1", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		await path2.set({ foo: "path2", count: 2 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			a: {
				b: {
					c: { foo: "path1", count: 1 },
					d: { foo: "path2", count: 2 },
				},
			},
		});
	});

	test("updates nested value", async () => {
		await namespaced.set({ foo: "initial", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		await namespaced.update((current) => ({
			...current,
			count: current.count + 1,
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		expect(namespaced.get()).toEqual({
			foo: "initial",
			count: 2,
		});
	});

	test("handles dot notation paths", () => {
		const dotPath = new NamespacedSettings(settings, "test.path", defaultValue);
		const slashPath = new NamespacedSettings(
			settings,
			"test/path",
			defaultValue,
		);

		expect(dotPath.get()).toEqual(slashPath.get());
	});

	test("getParent returns parent namespace", async () => {
		const child = new NamespacedSettings(
			settings,
			"parent/child",
			defaultValue,
		);
		const parent = child.getParent<Record<string, TestData>>();

		await child.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(parent.get()).toEqual({
			child: { foo: "test", count: 1 },
		});
	});

	test("getChild returns child namespace", async () => {
		const parent = new NamespacedSettings(settings, "parent", {});
		const child = parent.getChild<TestData>("child");

		await child.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			parent: {
				child: { foo: "test", count: 1 },
			},
		});
	});

	test("exists returns false for non-existent path", () => {
		expect(namespaced.exists()).toBe(false);
	});

	test("exists returns true for existing path", async () => {
		await namespaced.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(namespaced.exists()).toBe(true);
	});

	test("delete removes value", async () => {
		await namespaced.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		await namespaced.delete();
		mockTime.setTime(mockTime.getTime() + 30);

		expect(namespaced.exists()).toBe(false);
		expect(namespaced.get()).toEqual(defaultValue);
	});

	test("notifies listeners on set", async () => {
		namespaced.subscribe(listener);

		await namespaced.set({
			foo: "new",
			count: 42,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(2);
		expect(namespaced.get()).toEqual({
			foo: "new",
			count: 42,
		});
	});

	test("notifies listeners on update", async () => {
		namespaced.subscribe(listener);

		await namespaced.update((current) => ({
			...current,
			count: current.count + 1,
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(2);
		expect(namespaced.get()).toEqual({
			foo: "default",
			count: 1,
		});
	});

	test("unsubscribe stops notifications", async () => {
		const unsubscribe = namespaced.subscribe(listener);
		unsubscribe();

		await namespaced.set({
			foo: "new",
			count: 42,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(1);
	});

	test("multiple subscribers get notified", async () => {
		const listener2 = jest.fn();
		namespaced.subscribe(listener);
		namespaced.subscribe(listener2);

		await namespaced.set({
			foo: "new",
			count: 42,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener2).toHaveBeenCalledTimes(2);
	});

	test("only notifies on relevant path changes", async () => {
		namespaced.subscribe(listener);

		await settings.update((current) => ({
			...current,
			other: {
				path: { something: "else" },
			},
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(namespaced.get()).toEqual(defaultValue);
	});

	test("cleanup removes subscriptions", async () => {
		namespaced.subscribe(listener);
		namespaced.destroy();

		await namespaced.set({
			foo: "new",
			count: 42,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(1);
	});

	test("subscriber can update without triggering self-notification", async () => {
		const subscriber = jest.fn(async (value: TestData) => {
			// Only update on first call to avoid infinite loop in case the test fails
			if (subscriber.mock.calls.length === 1) {
				await namespaced.set({ foo: "updated", count: 100 });
			}
		});

		namespaced.subscribe(subscriber);

		// First call is from initial subscription
		expect(subscriber).toHaveBeenCalledTimes(1);
		expect(subscriber).toHaveBeenCalledWith(defaultValue);

		// Advance time to allow for any potential updates
		mockTime.setTime(mockTime.getTime() + 30);

		// Subscriber should not have been called again after its own update
		expect(subscriber).toHaveBeenCalledTimes(1);

		// Verify the update was successful
		expect(namespaced.get()).toEqual({ foo: "updated", count: 100 });
	});

	test("can create settings on existing namespace", async () => {
		// First, set some data in the namespace
		await namespaced.set({
			foo: "initial",
			count: 1,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		// Create a new settings instance on the same namespace
		const sameNamespace = new NamespacedSettings<TestData>(
			settings,
			"test/path",
			{
				foo: "different default",
				count: -1,
			},
		);

		// The new instance should see the existing data, not use its default
		expect(sameNamespace.get()).toEqual({
			foo: "initial",
			count: 1,
		});

		// Updates through either instance should be visible to both
		await sameNamespace.set({
			foo: "updated",
			count: 2,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		expect(namespaced.get()).toEqual({
			foo: "updated",
			count: 2,
		});
	});
	test("handles pattern matching syntax for array items", async () => {
		const listItem = new NamespacedSettings(
			settings,
			"folders.[guid=123]",
			defaultValue,
		);

		await listItem.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		// Raw storage should include pattern fields
		expect(settings.get()).toEqual({
			folders: [{ guid: "123", foo: "test", count: 1 }],
		});

		// But accessing through the pattern matched item should strip them
		expect(listItem.get()).toEqual({
			foo: "test",
			count: 1,
		});
	});

	test("updates existing array item when using pattern matching", async () => {
		await settings.update((current) => ({
			...current,
			folders: [
				{ guid: "123", foo: "initial", count: 0 },
				{ guid: "456", foo: "other", count: 2 },
			],
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const listItem = new NamespacedSettings(
			settings,
			"folders.[guid=123]",
			defaultValue,
		);

		await listItem.set({ foo: "updated", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			folders: [
				{ guid: "123", foo: "updated", count: 1 },
				{ guid: "456", foo: "other", count: 2 },
			],
		});
	});

	test("adds new array item when pattern doesn't match existing items", async () => {
		await settings.update((current) => ({
			...current,
			folders: [{ guid: "456", foo: "other", count: 2 }],
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const listItem = new NamespacedSettings(
			settings,
			"folders.[guid=123]",
			defaultValue,
		);

		await listItem.set({ foo: "new", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		// Raw storage should include pattern fields for both items
		expect(settings.get()).toEqual({
			folders: [
				{ guid: "456", foo: "other", count: 2 },
				{ guid: "123", foo: "new", count: 1 },
			],
		});

		// But accessing through pattern matching should strip them
		expect(listItem.get()).toEqual({
			foo: "new",
			count: 1,
		});
	});

	test("deletes array item when using pattern matching", async () => {
		await settings.update((current) => ({
			...current,
			folders: [
				{ guid: "123", foo: "test", count: 1 },
				{ guid: "456", foo: "other", count: 2 },
			],
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const listItem = new NamespacedSettings(
			settings,
			"folders.[guid=123]",
			defaultValue,
		);

		await listItem.delete();
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			folders: [{ guid: "456", foo: "other", count: 2 }],
		});
	});

	test("pattern matching notifies listeners correctly", async () => {
		const listItem = new NamespacedSettings(
			settings,
			"folders.[guid=123]",
			defaultValue,
		);
		listItem.subscribe(listener);
		expect(listener).toHaveBeenCalledTimes(1);

		await listItem.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenLastCalledWith({
			foo: "test",
			count: 1,
		});
	});

	test("pattern matching returns default when item not found", () => {
		const listItem = new NamespacedSettings(
			settings,
			"folders.[guid=123]",
			defaultValue,
		);

		expect(listItem.get()).toEqual(defaultValue);
	});

	test("handles current level wildcard pattern matching", async () => {
		await settings.update((current) => ({
			...current,
			"test-1": 3,
			"test-2": 4,
			other: 5,
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const testSettings = new NamespacedSettings(settings, "(test-*)", {});
		expect(testSettings.get()).toEqual({
			"test-1": 3,
			"test-2": 4,
		});
	});

	test("handles nested wildcard pattern matching", async () => {
		await settings.update((current) => ({
			...current,
			nested: {
				"test-1": 3,
				"test-2": 4,
				other: 5,
			},
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const testSettings = new NamespacedSettings(
			settings,
			"nested.(test-*)",
			{},
		);
		expect(testSettings.get()).toEqual({
			"test-1": 3,
			"test-2": 4,
		});
	});

	test("updates only matching keys with wildcard pattern", async () => {
		await settings.update((current) => ({
			...current,
			"test-1": 3,
			"test-2": 4,
			other: 5,
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const testSettings = new NamespacedSettings(settings, "(test-*)", {});
		await testSettings.set({
			"test-1": 6,
			"test-2": 7,
			other: 8, // Should be ignored
		});
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			"test-1": 6,
			"test-2": 7,
			other: 5, // Unchanged
		});
	});

	test("handles multiple wildcard patterns", async () => {
		await settings.update((current) => ({
			...current,
			"test-1": 1,
			"test-2": 2,
			"temp-1": 3,
			"temp-2": 4,
			other: 5,
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const testSettings = new NamespacedSettings(settings, "(test-*)", {});
		const tempSettings = new NamespacedSettings(settings, "(temp-*)", {});

		expect(testSettings.get()).toEqual({
			"test-1": 1,
			"test-2": 2,
		});

		expect(tempSettings.get()).toEqual({
			"temp-1": 3,
			"temp-2": 4,
		});
	});

	test("wildcard pattern returns empty object when no matches", () => {
		const testSettings = new NamespacedSettings(settings, "(test-*)", {});
		expect(testSettings.get()).toEqual({});
	});

	test("wildcard pattern notifies listeners of changes", async () => {
		const testSettings = new NamespacedSettings(settings, "(test-*)", {});
		testSettings.subscribe(listener);

		await settings.update((current) => ({
			...current,
			"test-1": 1,
			"test-2": 2,
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenLastCalledWith({
			"test-1": 1,
			"test-2": 2,
		});
	});

	afterEach(() => {
		if (namespaced) {
			namespaced.destroy();
		}
	});
});
