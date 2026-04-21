import { buildBufferedCM6ReplayEvents } from "src/merge-hsm/integration/replayBufferedEdits";

describe("buildBufferedCM6ReplayEvents", () => {
	it("tags every buffered replay event with the active CM6 view id", () => {
		const events = buildBufferedCM6ReplayEvents(
			[
				{
					changes: [{ from: 0, to: 0, insert: "hello" }],
					docText: "hello",
				},
				{
					changes: [{ from: 5, to: 5, insert: " world" }],
					docText: "hello world",
				},
			],
			"cm6-view-7",
		);

		expect(events).toEqual([
			{
				type: "CM6_CHANGE",
				changes: [{ from: 0, to: 0, insert: "hello" }],
				docText: "hello",
				viewId: "cm6-view-7",
			},
			{
				type: "CM6_CHANGE",
				changes: [{ from: 5, to: 5, insert: " world" }],
				docText: "hello world",
				viewId: "cm6-view-7",
			},
		]);
	});
});
