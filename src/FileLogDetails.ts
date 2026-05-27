import type { IFile } from "./IFile";

export function formatDuplicateGuidLog(
	existing: IFile,
	incoming: IFile,
): string {
	const guid = incoming.guid || existing.guid || "";
	return [
		"duplicate guid",
		`guid=${quoteLogValue(guid)}`,
		`existing=${formatFileLogDetails(existing)}`,
		`incoming=${formatFileLogDetails(incoming)}`,
	].join(" ");
}

function formatFileLogDetails(file: IFile): string {
	return [
		fileType(file),
		`(guid=${quoteLogValue(file.guid)}, `,
		`path=${quoteLogValue(file.path)})`,
	].join("");
}

function fileType(file: IFile): string {
	const type = file.constructor?.name;
	return type && type !== "Object" ? type : "IFile";
}

function quoteLogValue(value: string): string {
	return value ? JSON.stringify(value) : "<missing>";
}
