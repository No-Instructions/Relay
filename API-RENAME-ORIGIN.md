# Rename origin for third-party plugins

A plugin that preserves old paths as aliases should write the alias on the client that moves the file. Repeating that write on every client applying the same Relay move creates unnecessary edits. Relay exposes `api.v0.getRenameOrigin(oldPath, newPath)` so consumers can make this decision without inspecting shared-folder internals or guessing from event timing.

This is a read-only query: consumers need the answer during the existing vault callback. An asynchronous API or separate event stream would add ordering, replay, and lifecycle rules without providing that answer in time.

Resolve the current API and query it synchronously inside Obsidian's vault `rename` callback, before any `await` or deferred work:

```ts
this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
    const api = this.app.plugins.plugins["system3-relay"]?.api?.v0;
    if (typeof api?.getRenameOrigin !== "function") return;
    if (api.getRenameOrigin(oldPath, file.path) !== "client") return;
    // Schedule the consumer's local side effect.
}));
```

- `"relay"`: Relay is applying this move, including a reader-permission rollback or matching descendants of a folder move.
- `"client"`: no matching Relay move is active. This includes user moves, filesystem reconciliation, and other plugins. It does not identify a human, Relay membership, or a canonical mover, or distinguish another sync plugin's moves.
- Missing API or method: skip writes that require origin information. Earlier v0 APIs do not provide this capability.

Paths are vault-relative paths supplied by the event. Arbitrary pairs have no provenance guarantee. There is no history, and queries outside the synchronous callback are unsupported. Resolve the API again after `system3-relay:api-ready`; retained API objects throw after Relay unload, following the existing v0 lifecycle contract.

## Implementation and limits

Relay temporarily wraps the public `Vault.rename` method for each move it applies. Only the matching file and destination receive a scoped marker; unrelated renames pass through. Scopes are isolated per vault and remain active until the disk rename settles, including overlapping calls. The wrapper is removed on completion or rejection. A no-op destination does not install a wrapper.

The extra wrapper and per-vault in-flight scopes handle FileManager implementations that queue `Vault.rename` after their own promise settles. The operation waits for both promises, so a host that resolves FileManager successfully without ever calling `Vault.rename` for a non-no-op move would leave it pending. No private host methods, timers, stored rename history, user identity, or server protocol changes are added.

The host must not reject FileManager while leaving a not-yet-invoked `Vault.rename` queued. A rejection removes the wrapper; an already-invoked disk operation retains its origin scope until it settles. Source inspection and isolated execution of Obsidian 1.14.4 desktop's FileManager confirmed that its deferred branch resolves immediately, while its rejecting branch waits for disk invocation or fails before scheduling it. A replacement FileManager or another host with queued-then-rejected behavior is unsupported. Mobile timing remains unverified.

Public tests cover the v0 method, folder descendants, unrelated moves, overlapping operations, queued disk execution, failure cleanup, vault isolation, and unload. A prior local desktop trial on Obsidian 1.14.4 confirmed the client/Relay distinction at the rename callback. Network/server propagation, mobile host timing, and a fleet rollout have not been tested.

Run the public tests with `npm test -- --config jest.public-api.config.mjs --runInBand`.
