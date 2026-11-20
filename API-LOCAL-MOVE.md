# Local moves for third-party plugins

Some plugins respond to a move with an edit of their own. An alias plugin, for example, adds the old path to the moved note's aliases. In a shared folder, every client sees Obsidian's vault `rename` event for the same move: the client that made it, and each client that Relay later updates. If each client makes the edit, the note gets one edit per client. Relay fires `system3-relay:v0:local-move` only on the client that made the move, so a plugin can make its edit there and nowhere else.

```ts
const onReady = () => {
	const api = this.app.plugins.plugins["system3-relay"]?.api?.v0;
	if (typeof api?.isSharedPath !== "function") return; // older Relay: no event
	// Use the event for moves that touch a shared path; use the vault
	// `rename` event for moves where api.isSharedPath(oldPath) and
	// api.isSharedPath(newPath) are both false.
};
this.registerEvent(this.app.workspace.on("system3-relay:api-ready", onReady));
this.registerEvent(
	this.app.workspace.on("system3-relay:v0:local-move", ({ oldPath, newPath, kind }) => {
		// Schedule the side effect; don't edit files inside this callback.
	}),
);
onReady();
```

## What the event means

The event fires during Obsidian's vault `rename` callback for the moved path, so `app.vault.getAbstractFileByPath(newPath)` already resolves the moved file or folder. It fires for every rename made on this client where `isSharedPath` holds for either path, except the first three cases marked None below. That includes files Relay doesn't track, such as types it doesn't sync. A consumer that uses the event for shared paths and the vault event for the rest sees every move once. Relay publishes the moves it tracks, but the server may not have one yet; an offline move fires immediately and publishes on reconnect. Payloads are vault paths.

| Move | Events |
|---|---|
| A file within a shared folder, including one not yet uploaded | One |
| A folder within a shared folder | One for the folder, then one for each descendant on this disk, each in that descendant's own rename callback |
| A file between two shared folders | One, unless either folder rejects the move or the rename is Relay restoring a rejected move |
| A file into or out of shared folders | One |
| A folder into, out of, or between shared folders | One for the folder and one for each descendant, as Obsidian renames them |
| Moves Relay applies from another client | None |
| A move Relay rejects and restores: a reader moving a file Relay tracks | None |
| Renaming a shared folder itself | None, for the folder or its descendants |
| A move while Relay is not loaded | None, and no `api` exists to ask. Relay later sees a delete and a create, so other clients see no move either. |

Consecutive moves A to B to C fire two events, A to B and then B to C. Duplicate delivery is possible, as for the other v0 events, so side effects should be idempotent.

`isSharedPath(path)` says whether a vault path is inside a shared folder. Its presence on `api.v0` is the feature test for this event. Listeners registered with `registerEvent` are removed by Obsidian when the consumer unloads. While Relay is unloaded no events fire, and an API object retained past Relay's unload throws.

## Limits

Two clients can move the same note concurrently. Each fires the event for its own move, so both may make the side effect.

A folder rename's descendants are judged by the folder: each one's event fires in its own callback when the folder's move was local, and never when the folder's rename was Relay's or a shared folder's own rename. The public tests cover the event payload and order, how descendants inherit their folder's provenance, moves between shared folders, rejected halves, unload, and the declaration file's compatibility with the implementation. Which vault renames Relay accepts as local is decided in `SharedFolder`, whose tests are in the encrypted developer suite. Run the public tests with `npm test -- --config jest.public-api.config.mjs --runInBand`, and typecheck them with `npx tsc --noEmit -skipLibCheck -p tests`.
