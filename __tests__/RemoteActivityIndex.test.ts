import {
	RemoteActivityIndex,
	normalizeRemoteActivityTimestamp,
} from "../src/RemoteActivityIndex";

describe("RemoteActivityIndex", () => {
	test("keeps entries sorted newest first", () => {
		const index = new RemoteActivityIndex();

		index.upsert({ guid: "b", timestamp: 200 });
		index.upsert({ guid: "a", timestamp: 300 });
		index.upsert({ guid: "c", timestamp: 100 });

		expect(index.entries()).toEqual([
			{ guid: "a", timestamp: 300 },
			{ guid: "b", timestamp: 200 },
			{ guid: "c", timestamp: 100 },
		]);
	});

	test("keeps the latest timestamp for each guid", () => {
		const index = new RemoteActivityIndex();

		expect(index.upsert({ guid: "note", timestamp: 200, userId: "alice" })).toBe(true);
		expect(index.upsert({ guid: "note", timestamp: 100, userId: "bob" })).toBe(false);
		expect(index.upsert({ guid: "note", timestamp: 250 })).toBe(true);

		expect(index.get("note")).toEqual({
			guid: "note",
			timestamp: 250,
			userId: "alice",
		});
	});

	test("updates author when an event supplies it at the same timestamp", () => {
		const index = new RemoteActivityIndex();

		index.upsert({ guid: "note", timestamp: 200 });
		expect(index.upsert({ guid: "note", timestamp: 200, userId: "alice" })).toBe(true);

		expect(index.get("note")).toEqual({
			guid: "note",
			timestamp: 200,
			userId: "alice",
		});
	});

	test("hydrates, caps, and serializes newest entries", () => {
		const index = new RemoteActivityIndex(2);

		index.hydrate([
			{ guid: "old", timestamp: 100 },
			{ guid: "new", timestamp: 300 },
			{ guid: "middle", timestamp: 200 },
		]);

		expect(index.serialize()).toEqual([
			{ guid: "new", timestamp: 300 },
			{ guid: "middle", timestamp: 200 },
		]);
		expect(index.get("old")).toBeUndefined();
	});

	test("prunes entries older than a cutoff", () => {
		const index = new RemoteActivityIndex();
		index.hydrate([
			{ guid: "new", timestamp: 300 },
			{ guid: "middle", timestamp: 200 },
			{ guid: "old", timestamp: 100 },
		]);

		expect(index.pruneOlderThan(200)).toBe(true);
		expect(index.entries()).toEqual([
			{ guid: "new", timestamp: 300 },
			{ guid: "middle", timestamp: 200 },
		]);
	});

	test("normalizes second timestamps and rejects invalid future timestamps", () => {
		const now = 2_000_000_000_000;

		expect(normalizeRemoteActivityTimestamp(1_999_999_999, now)).toBe(
			1_999_999_999_000,
		);
		expect(normalizeRemoteActivityTimestamp(now + 120_000, now)).toBeNull();
		expect(normalizeRemoteActivityTimestamp("not a timestamp", now)).toBeNull();
	});
});
