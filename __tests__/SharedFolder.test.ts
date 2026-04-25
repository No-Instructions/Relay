import { expandDesiredRemotePaths } from "../src/syncPathUtils";

describe("expandDesiredRemotePaths", () => {
	test("keeps parent folders implied by remote children", () => {
		expect(
			Array.from(
				expandDesiredRemotePaths([
					"/Planning/2025 Security Roadmap.md",
					"/Metrics/Security KPIs Dashboard.md",
				]),
			).sort(),
		).toEqual([
			"/Metrics",
			"/Metrics/Security KPIs Dashboard.md",
			"/Planning",
			"/Planning/2025 Security Roadmap.md",
		]);
	});
});
