import { Settings } from "../src/SettingsStorage";
import { SyncSettingsManager } from "../src/SyncSettings";

class MemoryStorageAdapter<T> {
	private data: T | null = null;

	async loadData(): Promise<T | null> {
		return this.data;
	}

	async saveData(data: T): Promise<void> {
		this.data = data;
	}
}

async function makeSyncSettingsManager() {
	const settings = new Settings(new MemoryStorageAdapter<Record<string, any>>(), {});
	await settings.load();
	return new SyncSettingsManager(settings, "sync");
}

describe("SyncSettingsManager", () => {
	test("exposes markdown as an always-on category", async () => {
		const manager = await makeSyncSettingsManager();

		const markdown = manager.getCategories().markdown;

		expect(markdown).toMatchObject({
			name: "Markdown",
			enabled: true,
			extensions: ["md"],
			requiresStorage: false,
			canToggle: false,
		});
	});

	test("classifies which file types require attachment storage", async () => {
		const manager = await makeSyncSettingsManager();

		expect(manager.requiresStorage("notes/plan.md")).toBe(false);
		expect(manager.requiresStorage("boards/project.canvas")).toBe(false);
		expect(manager.requiresStorage("images/screenshot.png")).toBe(true);
		expect(manager.requiresStorage("data/custom.bin")).toBe(true);
	});
});
