import { formatDuplicateGuidLog } from "../src/FileLogDetails";
import type { IFile } from "../src/IFile";

class TestFile implements Partial<IFile> {
	constructor(
		public guid: string,
		public path: string,
	) {}
}

describe("formatDuplicateGuidLog", () => {
	test("renders duplicate guid details without object placeholders", () => {
		const existing = new TestFile(
			"duplicate-guid",
			"/Folder/existing.md",
		) as IFile;
		const incoming = new TestFile(
			"duplicate-guid",
			"/Folder/incoming.md",
		) as IFile;

		const message = formatDuplicateGuidLog(existing, incoming);

		expect(message).toBe(
			[
				'duplicate guid guid="duplicate-guid"',
				'existing=TestFile(guid="duplicate-guid", path="/Folder/existing.md")',
				'incoming=TestFile(guid="duplicate-guid", path="/Folder/incoming.md")',
			].join(" "),
		);
		expect(message).not.toContain("[object Object]");
		expect(message).not.toContain("[Complex Object");
		expect(message).not.toContain("\n");
	});
});
