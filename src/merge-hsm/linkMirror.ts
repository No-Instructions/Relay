import * as Y from "yjs";
import type { LinkCacheEntry, PositionedChange } from "./types";

/**
 * Link mirror: a per-link header on the note document that arbitrates the
 * target of each bound wikilink, so that several vaults repairing the same
 * link converge on one copy without inspecting the text to guess which copy
 * is surplus.
 *
 * `Y.Map("links")` holds one entry per bound link. The key is the Yjs item id
 * of the link's first character, which every replica shares and which an
 * edit inside the link leaves in place. The value names the file the link
 * resolved to when it was bound and the link's path as written. The text
 * owns which links exist; the map owns a bound link's target.
 */

export const LINK_MIRROR_ORIGIN = "link-mirror";
export const LINKS_MAP_NAME = "links";
const CONTENTS_TEXT_NAME = "contents";

export interface LinkBinding {
	guid: string;
	target: string;
}

export function serializeBinding(binding: LinkBinding): string {
	return JSON.stringify({ guid: binding.guid, target: binding.target });
}

export function parseBinding(value: unknown): LinkBinding | null {
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value) as { guid?: unknown; target?: unknown };
		if (
			parsed &&
			typeof parsed.guid === "string" &&
			typeof parsed.target === "string"
		) {
			return { guid: parsed.guid, target: parsed.target };
		}
	} catch {
		// not a binding
	}
	return null;
}

/** A wikilink or wiki embed read from the text at a known start offset. */
export interface LinkAt {
	start: number;
	end: number;
	embed: boolean;
	/** The path component as written, without subpath or alias. */
	path: string;
	/** The `#...` subpath including its leading `#`, or empty. */
	subpath: string;
	/** The alias after `|`, or null when the link has none. */
	alias: string | null;
}

/**
 * Read the wikilink or embed that begins exactly at `index`. Returns null
 * when no such link starts there. This reads one link at a known offset; it
 * is not a parser of the document.
 */
export function readLinkAt(text: string, index: number): LinkAt | null {
	let i = index;
	let embed = false;
	if (text.charCodeAt(i) === 0x21 /* ! */) {
		embed = true;
		i++;
	}
	if (!text.startsWith("[[", i)) return null;
	const open = i + 2;
	const close = text.indexOf("]]", open);
	if (close < 0) return null;
	const inner = text.slice(open, close);
	if (inner.length === 0 || inner.includes("\n")) return null;
	const pipe = inner.indexOf("|");
	const ref = pipe >= 0 ? inner.slice(0, pipe) : inner;
	const alias = pipe >= 0 ? inner.slice(pipe + 1) : null;
	const hash = ref.indexOf("#");
	const path = hash >= 0 ? ref.slice(0, hash) : ref;
	const subpath = hash >= 0 ? ref.slice(hash) : "";
	return { start: index, end: close + 2, embed, path, subpath, alias };
}

/** The link rewritten to `target`, keeping its embed form, subpath and alias. */
export function canonicalLinkText(link: LinkAt, target: string): string {
	const alias = link.alias === null ? "" : `|${link.alias}`;
	return `${link.embed ? "!" : ""}[[${target}${link.subpath}${alias}]]`;
}

/** The map key for the character at `index` of the note text. */
export function anchorKeyAt(ytext: Y.Text, index: number): string | null {
	const rel = Y.createRelativePositionFromTypeIndex(ytext, index, 0);
	const json = Y.relativePositionToJSON(rel) as {
		item?: { client: number; clock: number };
	};
	if (!json.item) return null;
	return `${json.item.client}:${json.item.clock}`;
}

/**
 * The current offset of an anchor in the note text, or null when this
 * replica does not hold the anchored character yet.
 */
export function resolveAnchor(doc: Y.Doc, key: string): number | null {
	const id = anchorId(key);
	if (id === null || anchorDeleted(doc, key)) return null;
	const rel = Y.createRelativePositionFromJSON({
		type: null,
		tname: CONTENTS_TEXT_NAME,
		item: { client: id.client, clock: id.clock },
		assoc: 0,
	});
	const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
	if (abs === null) return null;
	if (abs.type !== doc.getText(CONTENTS_TEXT_NAME)) return null;
	return abs.index;
}

function anchorId(key: string): Y.ID | null {
	const match = /^(\d+):(\d+)$/.exec(key);
	if (!match) return null;
	return Y.createID(Number(match[1]), Number(match[2]));
}

/**
 * Whether the anchor character has been deleted. A deleted character keeps
 * a position among its live neighbors, and text typed where a link used to
 * be lands at that position, so a position lookup cannot tell a deleted
 * anchor from a live one; the item itself carries the fact. An anchor this
 * replica has never received is not reported as deleted.
 */
export function anchorDeleted(doc: Y.Doc, key: string): boolean {
	const id = anchorId(key);
	if (id === null) return false;
	try {
		return Y.getItem(doc.store, id).deleted;
	} catch {
		return false;
	}
}

export interface LinkSpan {
	key: string;
	link: LinkAt;
}

/** Every binding whose anchor currently begins a link, with that link. */
export function boundLinkSpans(doc: Y.Doc, text: string): LinkSpan[] {
	const ymap = doc.getMap(LINKS_MAP_NAME);
	const spans: LinkSpan[] = [];
	for (const key of ymap.keys()) {
		const index = resolveAnchor(doc, key);
		if (index === null) continue;
		const link = readLinkAt(text, index);
		if (link) spans.push({ key, link });
	}
	return spans;
}

/**
 * The spans a set of changes touched: a replacement overlapping the span, or
 * an insertion strictly inside it. Insertions at either boundary leave the
 * link itself unchanged.
 */
export function touchedSpans(
	spans: LinkSpan[],
	changes: readonly PositionedChange[],
): LinkSpan[] {
	return spans.filter(({ link }) =>
		changes.some((change) =>
			change.from === change.to
				? change.insert.length > 0 &&
					link.start < change.from &&
					change.from < link.end
				: change.from < link.end && change.to > link.start,
		),
	);
}

/**
 * Sender rule, run inside the transaction that mutated the text: a touched
 * binding either follows the link now at its anchor, when that link names
 * the same file, or is removed. Offline, a changed target removes the
 * binding instead of minting a value that could win over a peer's newer one.
 */
export function reconcileTouchedBindings(
	doc: Y.Doc,
	text: string,
	touched: LinkSpan[],
	resolve: (path: string) => string | null,
	online: boolean,
): void {
	const ymap = doc.getMap(LINKS_MAP_NAME);
	for (const { key } of touched) {
		const binding = parseBinding(ymap.get(key));
		if (!binding) {
			ymap.delete(key);
			continue;
		}
		const index = resolveAnchor(doc, key);
		const link = index === null ? null : readLinkAt(text, index);
		const guid = link && link.path !== "" ? resolve(link.path) : null;
		if (link && guid !== null && guid === binding.guid) {
			if (link.path === binding.target) continue;
			if (!online) {
				ymap.delete(key);
				continue;
			}
			ymap.set(key, serializeBinding({ guid, target: link.path }));
		} else {
			ymap.delete(key);
		}
	}
}

export interface CacheBinding {
	key: string;
	binding: LinkBinding;
}

/**
 * Bindings a metadata cache entry supports for the current text: every
 * wikilink or embed whose cached original text is present at its cached
 * offset and whose path resolves to a shared file.
 */
export function bindingsFromCache(
	cache: LinkCacheEntry | null,
	text: string,
	ytext: Y.Text,
	resolve: (path: string) => string | null,
): CacheBinding[] {
	if (!cache) return [];
	const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])];
	const out: CacheBinding[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const offset = ref.position?.start?.offset;
		if (typeof offset !== "number" || typeof ref.original !== "string") continue;
		if (!text.startsWith(ref.original, offset)) continue;
		const link = readLinkAt(text, offset);
		if (!link || link.path === "") continue;
		const guid = resolve(link.path);
		if (guid === null) continue;
		const key = anchorKeyAt(ytext, offset);
		if (key === null || seen.has(key)) continue;
		seen.add(key);
		out.push({ key, binding: { guid, target: link.path } });
	}
	return out;
}

/**
 * Write bindings that differ from the map and, when pruning, remove entries
 * whose anchor no longer begins a link. Returns whether anything changed.
 */
export function applyBindings(
	doc: Y.Doc,
	text: string,
	bindings: CacheBinding[],
	prune: boolean,
): boolean {
	const ymap = doc.getMap(LINKS_MAP_NAME);
	let changed = false;
	for (const { key, binding } of bindings) {
		const serialized = serializeBinding(binding);
		if (ymap.get(key) === serialized) continue;
		ymap.set(key, serialized);
		changed = true;
	}
	if (prune) {
		for (const key of [...ymap.keys()]) {
			const index = resolveAnchor(doc, key);
			if (index === null) {
				if (!anchorDeleted(doc, key)) continue;
			} else if (readLinkAt(text, index)) {
				continue;
			}
			ymap.delete(key);
			changed = true;
		}
	}
	return changed;
}

/** The parameter type of the change set a transaction keeps per shared type. */
type ChangedType = Parameters<Y.Transaction["changed"]["get"]>[0];

/**
 * The keys of the link map a transaction wrote or deleted, whether or not
 * each write won. Yjs records the key of every map item it integrates in
 * the transaction's change set before deleting the value that item
 * supersedes, so a losing concurrent write and a superseding write are both
 * listed, although the update encodes a superseding write without its key.
 * The items are not counted: the store merges adjacent deleted items from
 * one client into one, so a count can stay flat across a write. `links` must
 * be the map instance the transaction ran against; callers obtain it before
 * the transaction, since integrating into a map nobody has asked for yet
 * leaves an untyped placeholder that the first `getMap` replaces.
 */
export function linkKeysWrittenIn(links: Y.Map<unknown>, tr: Y.Transaction): Set<string> {
	const keys = new Set<string>();
	const subs = tr.changed.get(links as unknown as ChangedType);
	if (subs) for (const key of subs) if (key !== null) keys.add(key);
	return keys;
}

/**
 * Receiver rule: for each key a remote update wrote, the link at its anchor
 * must read the binding's target. A link that names a different shared file
 * than its binding is a retarget the binding has not caught up with; it is
 * returned for rebinding rather than rewritten. Returns the canonical text,
 * the keys whose anchors no longer begin a link or duplicate another key's
 * link, and the bindings to correct.
 */
export function canonicalizeLinks(
	doc: Y.Doc,
	text: string,
	keys: Iterable<string>,
	resolve: (path: string) => string | null,
): { text: string; stale: string[]; rebind: CacheBinding[] } {
	const ymap = doc.getMap(LINKS_MAP_NAME);
	const claimed = new Set<number>();
	const edits: Array<{ link: LinkAt; replacement: string }> = [];
	const stale: string[] = [];
	const rebind: CacheBinding[] = [];
	for (const key of [...keys].sort()) {
		const binding = parseBinding(ymap.get(key));
		if (!binding) continue;
		const index = resolveAnchor(doc, key);
		if (index === null) {
			if (anchorDeleted(doc, key)) stale.push(key);
			continue;
		}
		const link = readLinkAt(text, index);
		if (!link || claimed.has(link.start)) {
			stale.push(key);
			continue;
		}
		claimed.add(link.start);
		if (link.path === binding.target) continue;
		const guid = link.path !== "" ? resolve(link.path) : null;
		if (guid !== null && guid !== binding.guid) {
			rebind.push({ key, binding: { guid, target: link.path } });
			continue;
		}
		// Only a target this replica can confirm names the bound file is
		// written into the text. A binding it cannot confirm changes nothing
		// here; a peer that can confirm it publishes the canonical text.
		if (resolve(binding.target) !== binding.guid) continue;
		edits.push({ link, replacement: canonicalLinkText(link, binding.target) });
	}
	edits.sort((a, b) => b.link.start - a.link.start);
	let out = text;
	for (const edit of edits) {
		out = out.slice(0, edit.link.start) + edit.replacement + out.slice(edit.link.end);
	}
	return { text: out, stale, rebind };
}
