import { describe, test, expect, jest } from "@jest/globals";
import { MockTimeProvider } from "./mocks/MockTimeProvider";

describe("MockTimeProvider debounce", () => {
	test("debounced function is called once after delay", () => {
		const mockTime = new MockTimeProvider();
		const mockFn = jest.fn();
		const debouncedFn = mockTime.debounce(mockFn, 1000);

		// Call the debounced function
		debouncedFn();

		// Function should not be called immediately
		expect(mockFn).not.toHaveBeenCalled();

		// Advance time by 500ms
		mockTime.setTime(mockTime.getTime() + 500);
		expect(mockFn).not.toHaveBeenCalled();

		// Advance time to just after the delay
		mockTime.setTime(mockTime.getTime() + 501);
		expect(mockFn).toHaveBeenCalledTimes(1);
	});

	test("multiple calls within delay only trigger once", () => {
		const mockTime = new MockTimeProvider();
		const mockFn = jest.fn();
		const debouncedFn = mockTime.debounce(mockFn, 1000);

		// Initial call
		debouncedFn();

		// Advance 300ms and call again
		mockTime.setTime(mockTime.getTime() + 300);
		debouncedFn();

		// Advance another 300ms and call again
		mockTime.setTime(mockTime.getTime() + 300);
		debouncedFn();

		// Advance time to trigger the last debounced call
		mockTime.setTime(mockTime.getTime() + 1000);

		expect(mockFn).toHaveBeenCalledTimes(1);
	});

	test("debounced function preserves arguments", () => {
		const mockTime = new MockTimeProvider();
		const mockFn = jest.fn();
		const debouncedFn = mockTime.debounce(mockFn, 1000);

		// Call with specific arguments
		debouncedFn("test", 123);

		// Advance time past delay
		mockTime.setTime(mockTime.getTime() + 1001);

		// Check if function was called with correct arguments
		expect(mockFn).toHaveBeenCalledWith("test", 123);
	});

	test("subsequent calls reset the timer", () => {
		const mockTime = new MockTimeProvider();
		const mockFn = jest.fn();
		const debouncedFn = mockTime.debounce(mockFn, 1000);

		// First call
		debouncedFn();

		// Advance time almost to delay
		mockTime.setTime(mockTime.getTime() + 900);

		// Second call - should reset timer
		debouncedFn();

		// Advance time past first delay but not second
		mockTime.setTime(mockTime.getTime() + 200);
		expect(mockFn).not.toHaveBeenCalled();

		// Advance time past second delay
		mockTime.setTime(mockTime.getTime() + 801);
		expect(mockFn).toHaveBeenCalledTimes(1);
	});

	test("uses default delay when not specified", () => {
		const mockTime = new MockTimeProvider();
		const mockFn = jest.fn();
		const debouncedFn = mockTime.debounce(mockFn); // Default 500ms

		debouncedFn();

		// Advance time by 400ms
		mockTime.setTime(mockTime.getTime() + 400);
		expect(mockFn).not.toHaveBeenCalled();

		// Advance time past default delay
		mockTime.setTime(mockTime.getTime() + 101);
		expect(mockFn).toHaveBeenCalledTimes(1);
	});
});
