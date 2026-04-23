import {
	EditorView,
	ViewPlugin,
	ViewUpdate,
	Decoration,
	type DecorationSet,
} from "@codemirror/view";
import { StateEffect, StateField, Range, type EditorState } from "@codemirror/state";
import { editorInfoField } from "obsidian";
import * as Y from "yjs";

import { getConnectionManager } from "../LiveViews";
import { usercolors } from "../User";

/**
 * Filter state for user-attribution highlighting.
 * - `null`: highlighting is off.
 * - `{ users: Set }` with empty set: highlight every attributable user.
 * - `{ users: Set }` with entries: highlight only users in the set.
 */
export type AttributionFilter = null | { users: ReadonlySet<string> };

export const setAttributionFilterEffect =
	StateEffect.define<AttributionFilter>();

export const attributionFilterField = StateField.define<AttributionFilter>({
	create: () => null,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setAttributionFilterEffect)) return effect.value;
		}
		return value;
	},
});

export const userAttributionTheme = EditorView.baseTheme({
	".cm-attribution": {},
});

function filterIncludes(
	filter: AttributionFilter,
	userId: string,
): boolean {
	if (filter === null) return false;
	if (filter.users.size === 0) return true;
	return filter.users.has(userId);
}

function readAttributionFilter(state: EditorState): AttributionFilter {
	return state.field(attributionFilterField, false) ?? null;
}

class UserAttributionPluginValue {
	decorations: DecorationSet = Decoration.none;
	editor: EditorView;

	constructor(editor: EditorView) {
		this.editor = editor;
		this.recalc();
	}

	update(update: ViewUpdate) {
		const filter = readAttributionFilter(update.state);
		const prevFilter = readAttributionFilter(update.startState);
		if (
			filter !== prevFilter ||
			update.docChanged ||
			(filter !== null && update.transactions.length > 0)
		) {
			this.recalc();
		}
	}

	private recalc() {
		const view = this.editor;
		const filter = readAttributionFilter(view.state);
		if (filter === null) {
			this.decorations = Decoration.none;
			return;
		}

		const fileInfo = view.state.field(editorInfoField, false) as any;
		const file = fileInfo?.file;
		if (!file) {
			this.decorations = Decoration.none;
			return;
		}

		const connectionManager = getConnectionManager(view);
		const folder = connectionManager?.sharedFolders.lookup(file.path);
		const doc = folder?.proxy.getDoc(file.path);
		const ydoc = doc?.localDoc as Y.Doc | undefined;
		if (!ydoc) {
			this.decorations = Decoration.none;
			return;
		}

		const clientToUser = new Map<string, string>();
		const usersMap = ydoc.getMap("users");
		usersMap.forEach((entry: any, userId: string) => {
			const ids = entry?.get?.("ids");
			const idsArray = typeof ids?.toArray === "function" ? ids.toArray() : null;
			if (!idsArray) return;
			for (const cid of idsArray) {
				clientToUser.set(String(cid), userId);
			}
		});

		const relayUsers = connectionManager?.sharedFolders?.manager?.users;
		const resolveName = (userId: string): string => {
			const u = relayUsers?.get?.(userId);
			return u?.name || userId;
		};

		const awareness = (doc as any)?._provider?.awareness;
		const userColors = new Map<string, { color: string; light: string }>();
		const usedColors = new Set<string>();
		awareness?.getStates?.().forEach((state: any) => {
			const u = state?.user;
			if (u?.id && u?.color) {
				userColors.set(u.id, {
					color: u.color,
					light: u.colorLight || u.color + "33",
				});
				usedColors.add(u.color);
			}
		});

		// Offline users get a deterministic palette color that doesn't collide
		// with an online peer's awareness color. Uses the userId hash as the
		// starting index, then walks the palette until it finds a free color.
		const resolveColor = (
			userId: string,
		): { color: string; light: string } => {
			const existing = userColors.get(userId);
			if (existing) return existing;
			let h = 0;
			for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
			const start = Math.abs(h) % usercolors.length;
			for (let i = 0; i < usercolors.length; i++) {
				const candidate = usercolors[(start + i) % usercolors.length];
				if (!usedColors.has(candidate.color)) {
					userColors.set(userId, candidate);
					usedColors.add(candidate.color);
					return candidate;
				}
			}
			// All 8 palette colors taken — fall back to the hashed pick.
			const fallback = usercolors[start];
			userColors.set(userId, fallback);
			return fallback;
		};

		const ytext = ydoc.getText("contents");
		const doclen = view.state.doc.length;
		const ranges: Range<Decoration>[] = [];
		let pos = 0;
		let item: any = (ytext as any)._start;
		while (item) {
			const len = item.length as number;
			if (!item.deleted) {
				const userId = clientToUser.get(String(item.id.client));
				const from = pos;
				const to = Math.min(pos + len, doclen);
				if (userId && to > from && filterIncludes(filter, userId)) {
					const display = resolveName(userId);
					const color = resolveColor(userId);
					ranges.push(
						Decoration.mark({
							attributes: {
								style: `background-color: ${color.light}; border-bottom: 1px solid ${color.color}`,
								title: `Written by ${display}`,
							},
							class: "cm-attribution",
						}).range(from, to),
					);
				}
				pos += len;
			}
			item = item.right;
		}

		this.decorations = Decoration.set(ranges, true);
	}
}

export const userAttributionPlugin = ViewPlugin.fromClass(
	UserAttributionPluginValue,
	{ decorations: (v) => v.decorations },
);

function cmFromEditor(editor: any): EditorView | undefined {
	return editor?.cm as EditorView | undefined;
}

export function getAttributionFilter(editor: any): AttributionFilter {
	const cm = cmFromEditor(editor);
	return cm ? readAttributionFilter(cm.state) : null;
}

export function setAttributionFilter(
	editor: any,
	filter: AttributionFilter,
): void {
	const cm = cmFromEditor(editor);
	if (!cm) return;
	cm.dispatch({ effects: setAttributionFilterEffect.of(filter) });
}

/** Returns true if attribution is enabled in any form (global or per-user). */
export function isUserAttributionOn(editor: any): boolean {
	return getAttributionFilter(editor) !== null;
}

/**
 * Global toggle: off ↔ show-all.
 * If the current filter is per-user, switches to off.
 */
export function toggleUserAttribution(editor: any): boolean {
	const filter = getAttributionFilter(editor);
	const next: AttributionFilter =
		filter === null ? { users: new Set<string>() } : null;
	setAttributionFilter(editor, next);
	return next !== null;
}

/** Toggle attribution for a specific user. */
export function toggleUserAttributionForUser(
	editor: any,
	userId: string,
): AttributionFilter {
	const filter = getAttributionFilter(editor);
	let next: AttributionFilter;
	if (filter === null) {
		next = { users: new Set([userId]) };
	} else if (filter.users.size === 0) {
		next = { users: new Set([userId]) };
	} else {
		const users = new Set(filter.users);
		if (users.has(userId)) users.delete(userId);
		else users.add(userId);
		next = users.size === 0 ? null : { users };
	}
	setAttributionFilter(editor, next);
	return next;
}
