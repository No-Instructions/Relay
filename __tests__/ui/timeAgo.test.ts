import { formatTimeAgo } from "../../src/ui/timeAgo";

describe("formatTimeAgo", () => {
	const now = new Date("2026-05-11T12:00:00Z").getTime();

	test.each([
		[5 * 1000, "just now"],
		[30 * 1000, "a few seconds ago"],
		[60 * 1000, "1 minute ago"],
		[15 * 60 * 1000, "15 minutes ago"],
		[60 * 60 * 1000, "1 hour ago"],
		[23 * 60 * 60 * 1000, "23 hours ago"],
		[24 * 60 * 60 * 1000, "1 day ago"],
		[135 * 60 * 60 * 1000, "5 days ago"],
		[14 * 24 * 60 * 60 * 1000, "2 weeks ago"],
		[45 * 24 * 60 * 60 * 1000, "1 month ago"],
		[120 * 24 * 60 * 60 * 1000, "4 months ago"],
		[400 * 24 * 60 * 60 * 1000, "1 year ago"],
		[800 * 24 * 60 * 60 * 1000, "2 years ago"],
	])("formats %d ms as %s", (ageMs, expected) => {
		expect(formatTimeAgo(now - ageMs, now)).toBe(expected);
	});
});
