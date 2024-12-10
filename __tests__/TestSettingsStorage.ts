import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import type { Mock } from "jest-mock";
import { MockTimeProvider } from "./mocks/MockTimeProvider";
import { NamespacedSettings, Settings } from "../src/SettingsStorage";
import { PostOffice } from "../src/observable/Postie";

interface TestData {
	foo: string;
	count: number;
}

/**
 * A simple in-memory storage adapter for testing purposes.
 * Implements the StorageAdapter interface expected by SettingsStorage.
 */
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
	let listener: Mock;

	beforeEach(async () => {
		// Initialize the mock time provider and post office for simulating time-based events
		mockTime = new MockTimeProvider();
		PostOffice.destroy();
		// @ts-ignore - accessing private constructor for testing
		PostOffice["instance"] = new PostOffice(mockTime);
		PostOffice["_destroyed"] = false;

		// Set up the in-memory storage and settings instance
		storage = new MemoryStorageAdapter();
		settings = new Settings(storage, {});
		await settings.load();

		// Set up a mock listener function for subscription testing
		listener = jest.fn();
	});

	test("returns empty object when path does not exist", () => {
		/**
		 * Tests that the NamespacedSettings returns an empty object when the specified path is not found in the settings.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
		expect(namespaced.get()).toEqual({});
	});

	test("handles slash-separated paths", async () => {
		/**
		 * Tests that the NamespacedSettings correctly handles paths separated by slashes `/`.
		 * Sets a value at a deeply nested path and verifies that it is stored correctly within the settings.
		 */
		const nested = new NamespacedSettings(settings, "deeply/nested/path");
		await nested.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			deeply: {
				nested: {
					path: { foo: "test", count: 1 },
				},
			},
		});
	});

	test("sets and gets nested value", async () => {
		/**
		 * Tests setting and retrieving a nested value within the settings.
		 * Verifies that the data is correctly stored and can be retrieved via the NamespacedSettings instance.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
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
		/**
		 * Tests setting values at multiple nested paths within the settings.
		 * Verifies that each path maintains its own data, and the settings object reflects both changes.
		 */
		const path1 = new NamespacedSettings(settings, "a/b/c");
		const path2 = new NamespacedSettings(settings, "a/b/d");

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
		/**
		 * Tests updating an existing nested value within the settings.
		 * Uses the update method to modify a specific property and verifies the change.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
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

	test("getParent returns parent namespace", async () => {
		/**
		 * Tests retrieving the parent namespace of a NamespacedSettings instance.
		 * Verifies that changes in the child are reflected in the parent's data.
		 */
		const child = new NamespacedSettings(settings, "parent/child");
		const parent = child.getParent();

		await child.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(parent.get()).toEqual({
			child: { foo: "test", count: 1 },
		});
	});

	test("getChild returns child namespace", async () => {
		/**
		 * Tests retrieving a child namespace from a parent NamespacedSettings instance.
		 * Verifies that the child can set values that are stored under the parent path.
		 */
		const parent = new NamespacedSettings(settings, "parent");
		const child = parent.getChild<TestData>("child");

		await child.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			parent: {
				child: { foo: "test", count: 1 },
			},
		});
	});

	test("exists returns true for existing path", async () => {
		/**
		 * Tests the exists method to confirm it returns true when the path exists in the settings.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
		await namespaced.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(namespaced.exists()).toBe(true);
	});

	test("exists returns false for non-existing path", () => {
		/**
		 * Tests the exists method to confirm it returns false when the path does not exist in the settings.
		 */
		const namespaced = new NamespacedSettings(settings, "non/existing/path");

		expect(namespaced.exists()).toBe(false);
	});

	test("delete removes value", async () => {
		/**
		 * Tests the delete method to ensure it removes the specified value from the settings.
		 * Verifies that after deletion, exists returns false and get returns an empty object.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
		await namespaced.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		await namespaced.delete();
		mockTime.setTime(mockTime.getTime() + 30);

		expect(namespaced.exists()).toBe(false);
		expect(namespaced.get()).toEqual({});
	});

	test("notifies listeners on set with array pattern match", async () => {
		/**
		 * Tests that listeners subscribed to a NamespacedSettings instance are notified upon setting a new value.
		 * Verifies that the listener function is called with the updated value.
		 */
		const namespaced = new NamespacedSettings(
			settings,
			"test/[guid=123]/settings",
		);
		namespaced.subscribe(listener);

		console.log(namespaced.get());

		await namespaced.set({
			foo: "new",
			count: 2,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		// Called once upon subscription and once after setting a new value
		expect(listener).toHaveBeenCalledTimes(2);
		expect(namespaced.get()).toEqual({
			foo: "new",
			count: 2,
		});
	});
	test("notifies listeners on set with pattern match", async () => {
		/**
		 * Tests that listeners subscribed to a NamespacedSettings instance are notified upon setting a new value.
		 * Verifies that the listener function is called with the updated value.
		 */
		const namespaced = new NamespacedSettings(settings, "(debugging)");
		namespaced.subscribe(listener);

		console.log(namespaced.get());

		await namespaced.set({
			debugging: true,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		await namespaced.set({
			debugging: false,
		});
		mockTime.setTime(mockTime.getTime() + 30);
		// Called once upon subscription and once after setting a new value
		expect(listener).toHaveBeenCalledTimes(3);
		expect(namespaced.get()).toEqual({
			debugging: false,
		});
	});

	test("unsubscribe stops notifications", async () => {
		/**
		 * Tests that unsubscribing a listener stops it from receiving further notifications.
		 * Verifies by setting a new value after unsubscribing and checking that the listener is not called again.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
		const unsubscribe = namespaced.subscribe(listener);
		unsubscribe();

		await namespaced.set({
			foo: "new",
			count: 42,
		});
		mockTime.setTime(mockTime.getTime() + 30);

		// Only called once upon initial subscription
		expect(listener).toHaveBeenCalledTimes(1);
	});

	test("handles pattern matching syntax for array items", async () => {
		/**
		 * Tests that NamespacedSettings can handle array item selection using pattern matching syntax.
		 * Sets a value in an array where items are matched based on a key-value pair.
		 * Verifies that the data is stored correctly within the array.
		 */
		const listItem = new NamespacedSettings(settings, "folders/[guid=123]");

		const itemSettings = listItem.getChild<{ foo: string; count: number }>(
			"settings",
		);

		// Clear any existing data
		await settings.update(() => ({}));

		// Set the new value and wait for it to be processed
		await itemSettings.set({ foo: "test", count: 1 });
		await settings.save();

		// Force update notification
		await settings.update((current) => ({ ...current }));
		mockTime.setTime(mockTime.getTime() + 30);

		// Now check both the raw settings and the namespaced view
		expect(settings.get()).toEqual({
			folders: [{ guid: "123", settings: { foo: "test", count: 1 } }],
		});

		const result = itemSettings.get();
		expect(result).toEqual({
			foo: "test",
			count: 1,
		});

		const itemSettingsDirect = new NamespacedSettings(
			settings,
			"folders/[guid=123]/settings",
		);
		const directResult = itemSettingsDirect.get();
		expect(directResult).toEqual({
			foo: "test",
			count: 1,
		});
	});

	test("updates existing array item when using pattern matching", async () => {
		/**
		 * Tests updating an existing item within an array using pattern matching syntax.
		 * Ensures that the correct item is updated and others remain unchanged.
		 */
		// Clear any existing data
		await settings.update(() => ({}));

		// Set up initial state
		await settings.update(() => ({
			folders: [
				{ guid: "123", settings: { foo: "initial", count: 0 } },
				{ guid: "456", settings: { foo: "other", count: 2 } },
			],
		}));
		await settings.save();
		mockTime.setTime(mockTime.getTime() + 30);

		const listItem = new NamespacedSettings(
			settings,
			"folders/[guid=123]/settings",
		);

		// Update the item and wait for processing
		await listItem.set({ foo: "updated", count: 1 });
		await settings.save();

		// Force update notification
		await settings.update((current) => ({ ...current }));
		mockTime.setTime(mockTime.getTime() + 30);

		// Check both raw settings and namespaced view
		expect(settings.get()).toEqual({
			folders: [
				{ guid: "123", settings: { foo: "updated", count: 1 } },
				{ guid: "456", settings: { foo: "other", count: 2 } },
			],
		});

		const result = listItem.get();
		expect(result).toEqual({
			foo: "updated",
			count: 1,
		});
	});

	test("deletes array item when using pattern matching", async () => {
		/**
		 * Tests deleting an item from an array using pattern matching syntax.
		 * Verifies that the correct item is removed and others remain unaffected.
		 */
		await settings.update((current) => ({
			...current,
			folders: [
				{ guid: "123", foo: "test", count: 1 },
				{ guid: "456", foo: "other", count: 2 },
			],
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const listItem = new NamespacedSettings(settings, "folders/[guid=123]");

		await listItem.delete();
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			folders: [{ guid: "456", foo: "other", count: 2 }],
		});
	});

	test("handles current level wildcard pattern matching", async () => {
		/**
		 * Tests that NamespacedSettings can handle wildcard pattern matching at the current level.
		 * Retrieves all keys that match the wildcard pattern and verifies the result.
		 */
		await settings.update((current) => ({
			...current,
			"test-1": 3,
			"test-2": 4,
			other: 5,
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const testSettings = new NamespacedSettings(settings, "(test-*)");
		expect(testSettings.get()).toEqual({
			"test-1": 3,
			"test-2": 4,
		});
	});

	test("sets values using wildcard pattern matching", async () => {
		/**
		 * Tests setting values using wildcard pattern matching.
		 * Verifies that the intended keys are set while others remain unchanged.
		 */
		const testSettings = new NamespacedSettings(settings, "(feature-*)");
		await testSettings.set({
			"feature-1": true,
			"feature-2": false,
			"not-matching": "should be ignored",
		});
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			"feature-1": true,
			"feature-2": false,
		});
	});

	test("getChild with pattern matching", async () => {
		/**
		 * Tests retrieving a child NamespacedSettings when the parent uses pattern matching.
		 * Ensures that child paths are correctly resolved and can set values.
		 */
		const parent = new NamespacedSettings(settings, "parent/*");
		const child = parent.getChild<TestData>("child");

		await child.set({ foo: "value", count: 10 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			parent: {
				"*": {
					child: { foo: "value", count: 10 },
				},
			},
		});
	});

	test("throws error when setting undefined value", async () => {
		/**
		 * Tests that an error is thrown when attempting to set an undefined value.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");

		await expect(
			namespaced.set(undefined as unknown as TestData),
		).rejects.toThrow("Cannot set undefined value");
	});

	test("destroyed NamespacedSettings throws error on use", () => {
		/**
		 * Tests that a destroyed NamespacedSettings instance throws an error when methods are called.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
		namespaced.destroy();

		expect(() => namespaced.get()).toThrow("Cannot use destroyed settings");
		expect(() => namespaced.set({ foo: "test", count: 1 })).rejects.toThrow(
			"Cannot use destroyed settings",
		);
		expect(() => namespaced.exists()).toThrow("Cannot use destroyed settings");
		expect(() => namespaced.delete()).rejects.toThrow(
			"Cannot use destroyed settings",
		);
		expect(() => namespaced.subscribe(listener)).toThrow(
			"Cannot use destroyed settings",
		);
	});

	test("handles empty settings object", () => {
		/**
		 * Tests that NamespacedSettings can handle an empty settings object without errors.
		 */
		const emptySettings = new NamespacedSettings(settings, "empty/path");
		expect(emptySettings.get()).toEqual({});
	});

	test("flush forces update", async () => {
		/**
		 * Tests the flush method, which forces an update notification to listeners.
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
		namespaced.subscribe(listener);

		await namespaced.flush();
		mockTime.setTime(mockTime.getTime() + 30);

		// Called once upon subscription and once after flush
		expect(listener).toHaveBeenCalledTimes(2);
	});

	test("getPath returns correct path", () => {
		/**
		 * Tests that getPath returns the accurate path string used by the NamespacedSettings.
		 */
		const namespaced = new NamespacedSettings(settings, "some/nested/path");
		expect(namespaced.getPath()).toEqual("some/nested/path");
	});

	test("does not overwrite existing settings when setting new namespace", async () => {
		/**
		 * Tests that setting a new NamespacedSettings does not overwrite unrelated existing settings.
		 */
		await settings.update(() => ({
			existing: {
				data: true,
			},
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		const namespaced = new NamespacedSettings(settings, "new/namespace");
		await namespaced.set({ foo: "test", count: 1 });
		mockTime.setTime(mockTime.getTime() + 30);

		expect(settings.get()).toEqual({
			existing: {
				data: true,
			},
			new: {
				namespace: {
					foo: "test",
					count: 1,
				},
			},
		});
	});

	test("updates listeners when settings change externally", async () => {
		/**
		 * Tests that listeners are notified when the underlying settings change externally (not through the NamespacedSettings instance).
		 */
		const namespaced = new NamespacedSettings(settings, "test/path");
		namespaced.subscribe(listener);

		await settings.update((current) => ({
			...current,
			test: {
				path: { foo: "external", count: 99 },
			},
		}));
		mockTime.setTime(mockTime.getTime() + 30);

		expect(listener).toHaveBeenCalledTimes(2);
		expect(namespaced.get()).toEqual({
			foo: "external",
			count: 99,
		});
	});
});
