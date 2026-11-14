import type { EventRef, Workspace } from "obsidian";
import type { Api as ConsumerApi, LocalMove as ConsumerLocalMove } from "../relay-plugin-api";
import {
	crossFolderMoves,
	expectDescendants,
	localMoves,
	takeDescendant,
	type PendingDescendants,
} from "../src/LocalMove";
import {
	API_UNLOADED_ERROR,
	createPublicApi,
	type Api,
	type LocalMove,
} from "../src/PublicAPI";

// The consumer declaration and the implementation must stay interchangeable.
const toConsumer = (api: Api): ConsumerApi => api;
const fromConsumer = (api: ConsumerApi): Api => api;
const moveToConsumer = (move: LocalMove): ConsumerLocalMove => move;
const moveFromConsumer = (move: ConsumerLocalMove): LocalMove => move;
const subscribe = (workspace: Workspace): EventRef =>
	workspace.on("system3-relay:v0:local-move", (move: ConsumerLocalMove) => move.kind);
void [toConsumer, fromConsumer, moveToConsumer, moveFromConsumer, subscribe];

function handle(isSharedPath: (path: string) => boolean = () => false) {
	const events: [string, unknown][] = [];
	const workspace = {
		trigger: (name: string, event?: unknown) => {
			events.push([name, event]);
		},
	};
	const publicApi = createPublicApi(
		{ users: { values: () => [], on: () => () => {} } } as any,
		{ on: () => () => {} } as any,
		{ register: jest.fn(), unregister: jest.fn() } as any,
		workspace,
		() => {},
		isSharedPath,
	);
	return { ...publicApi, events };
}

test("reports each accepted move as one event, in order", () => {
	const { reportLocalMoves, events } = handle();
	reportLocalMoves(localMoves("shared/a.md", "shared/b.md", "file"));
	reportLocalMoves(localMoves("shared/b.md", "shared/c.md", "file"));
	expect(events).toEqual([
		["system3-relay:v0:local-move", { oldPath: "shared/a.md", newPath: "shared/b.md", kind: "file" }],
		["system3-relay:v0:local-move", { oldPath: "shared/b.md", newPath: "shared/c.md", kind: "file" }],
	]);
});

test("each listener receives its own payload", () => {
	const { reportLocalMoves, events } = handle();
	const move: LocalMove = { oldPath: "shared/a.md", newPath: "shared/b.md", kind: "file" };
	reportLocalMoves([move, move]);
	expect(events[0][1]).not.toBe(move);
	expect(events[0][1]).not.toBe(events[1][1]);
	expect(events[1][1]).toEqual(move);
});

test("a move between shared folders is one move, and none if either half is Relay's own work", () => {
	const move = localMoves("one/a.md", "two/a.md", "file");
	expect(crossFolderMoves(move, move)).toEqual(move);
	expect(crossFolderMoves([], move)).toEqual(move);
	expect(crossFolderMoves(move, [])).toEqual(move);
	expect(crossFolderMoves([], [])).toEqual([]);
	expect(crossFolderMoves(null, move)).toEqual([]);
	expect(crossFolderMoves(move, null)).toEqual([]);
});

test("isSharedPath answers from Relay's shared folders", () => {
	const { api } = handle((path) => path.startsWith("shared/"));
	expect(api.v0.isSharedPath("shared/a.md")).toBe(true);
	expect(api.v0.isSharedPath("private/a.md")).toBe(false);
});

test("nothing is reported after unload, and the retained API throws", () => {
	const { api, reportLocalMoves, detach, events } = handle();
	detach();
	reportLocalMoves(localMoves("shared/a.md", "shared/b.md", "file"));
	expect(events).toEqual([]);
	expect(() => api.v0.isSharedPath("shared/a.md")).toThrow(API_UNLOADED_ERROR);
});

function tree() {
	const note = { path: "shared/old/sub/note.md" };
	const sub = { path: "shared/old/sub", children: [note] };
	const sibling = { path: "shared/old/sibling.md" };
	const folder = { path: "shared/new", children: [sub, sibling] };
	return { folder, sub, note, sibling };
}

test("a folder's descendants inherit its provenance in their own callbacks, once each", () => {
	for (const local of [true, false]) {
		const pending: PendingDescendants = new Map();
		const { folder, sub, note, sibling } = tree();
		expectDescendants(pending, folder, "shared/old", local);
		for (const [node, newPath] of [
			[sub, "shared/new/sub"],
			[note, "shared/new/sub/note.md"],
			[sibling, "shared/new/sibling.md"],
		] as const) {
			const oldPath = node.path;
			node.path = newPath;
			expect(takeDescendant(pending, node, oldPath)).toBe(local);
			expect(takeDescendant(pending, node, oldPath)).toBeUndefined();
		}
		expect(pending.size).toBe(0);
	}
});

test("a rename that is not the expected descendant callback inherits nothing", () => {
	const pending: PendingDescendants = new Map();
	const { folder, sibling } = tree();
	expectDescendants(pending, folder, "shared/old", true);
	expect(takeDescendant(pending, { path: "shared/new/sibling.md" }, "shared/old/sibling.md")).toBeUndefined();
	expect(takeDescendant(pending, sibling, "elsewhere/sibling.md")).toBeUndefined();
});

test("a descendant already at its new path still matches its own rename callback", () => {
	const pending: PendingDescendants = new Map();
	const folderNote = { path: "shared/new/old.md" };
	const child = { path: "shared/old/child.md" };
	expectDescendants(pending, { path: "shared/new", children: [folderNote, child] }, "shared/old", true);
	expect(takeDescendant(pending, folderNote, "shared/old/old.md")).toBe(true);
	// A later rename of the folder note by another plugin is its own move.
	folderNote.path = "shared/new/new.md";
	expect(takeDescendant(pending, folderNote, "shared/new/old.md")).toBeUndefined();
	child.path = "shared/new/child.md";
	expect(takeDescendant(pending, child, "shared/old/child.md")).toBe(true);
});
