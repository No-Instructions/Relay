import type { TFile, Vault } from "obsidian";
import { generateHash } from "./hashing";

/**
 * Canonical in-memory line ending for note text. A note's CRDT contents and
 * content hash are normalized to LF so they are identical regardless of the
 * on-disk EOL. Obsidian saves LF on every platform (the editor joins lines
 * with LF), but external tools writing to a vault — git checkouts with
 * autocrlf, Windows editors, other sync clients — produce CRLF files, and
 * Obsidian's vault.read returns disk bytes raw apart from BOM stripping.
 * Hashing or diffing raw disk bytes would make the same logical note diverge
 * between peers (a persistent LCA-hash mismatch, and CRLF-shifted
 * machine-edit diffs that corrupt concurrent link repairs).
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
