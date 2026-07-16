/**
 * The document's disk loader could not find its backing file.
 *
 * This is distinct from corrupt-state and invariant failures: vault create/delete
 * propagation can legitimately race an idle document's boot-time disk read.
 */
export class DiskFileNotFoundError extends Error {
	constructor(path: string) {
		super(`[Document] Cannot read disk content for ${path}: TFile not found`);
		this.name = "DiskFileNotFoundError";
	}
}
