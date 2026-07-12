import type { TFile, Vault } from "obsidian";
import { generateHash } from "./hashing";

/**
 * Canonical in-memory line ending for note text. A note's CRDT contents and
 * content hash are normalized to LF so they are identical regardless of the
 * platform's on-disk EOL: Obsidian on Windows writes CRLF, and hashing or
 * diffing raw disk bytes would otherwise make the same logical note diverge
 * between a Windows peer and a Linux/macOS peer (a persistent LCA-hash mismatch,
 * and CRLF-shifted machine-edit diffs that corrupt concurrent link repairs).
 *
 * Note text only. Binary and attachment content is never routed through here —
 * it must stay byte-exact (see SyncFile's readBinary path).
 */
export function normalizeNoteText(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/**
 * Read a note file from the vault as canonical LF text with its content hash.
 * The returned contents are what enter both the content hash and the CRDT, so a
 * note ingested on Windows (CRLF) hashes and diffs identically to the same note
 * on Linux/macOS (LF).
 */
export async function readNoteText(
	vault: Vault,
	tfile: TFile,
): Promise<{ contents: string; hash: string; mtime: number }> {
	const contents = normalizeNoteText(await vault.read(tfile));
	const hash = await generateHash(new TextEncoder().encode(contents).buffer);
	return { contents, hash, mtime: tfile.stat.mtime };
}
