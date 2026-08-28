# Public API

Use Relay's public API to resolve collaborator identities and make custom text
views participate in live editing. The boundary sends plain records, so your
plugin owns its state and remains independent of Relay's load lifecycle.

To connect your plugin:

1. [Copy the contract](#copy-the-contract).
2. [Build local stores](#build-local-stores).
3. [Connect to Relay](#connect-to-relay).
4. [Register your text view](#register-your-text-view), if your plugin provides
   one.

## Copy the contract

Copy `relay-plugin-api.d.ts` into your plugin. It imports only `EventRef` from
Obsidian and defines the complete API, user records, event envelopes, and
workspace event overloads.

Resolve the API through Obsidian's plugin registry:

```ts
import type { App } from "obsidian";
import type { ApiV0 } from "./relay-plugin-api";

function getRelayApi(app: App): ApiV0 | null {
  const plugins = (
    app as App & {
      plugins?: {
        plugins?: Record<string, { api?: { v0?: ApiV0 } }>;
      };
    }
  ).plugins?.plugins;
  return plugins?.["system3-relay"]?.api?.v0 ?? null;
}
```

Do not retain the returned API across a Relay reload. Resolve it again whenever
`system3-relay:api-ready` fires. The event is payload-free.

## Build local stores

Relay returns snapshots and emits full-record deltas. Keep those records in
your bundle so your UI can read current state synchronously and subscribe to
changes. A dependency-free store can satisfy the Svelte store contract while
also working from imperative TypeScript:

```ts
type Unsubscriber = () => void;
type Equality<T> = (left: T, right: T) => boolean;

export class ObservableValue<T> {
  private subscribers = new Set<(value: T) => void>();

  constructor(
    private current: T,
    private equals: Equality<T> = Object.is,
  ) {}

  get value(): T {
    return this.current;
  }

  set(value: T): boolean {
    if (this.equals(this.current, value)) return false;
    this.current = value;
    for (const run of [...this.subscribers]) run(value);
    return true;
  }

  subscribe(run: (value: T) => void): Unsubscriber {
    this.subscribers.add(run);
    run(this.current);
    return () => { this.subscribers.delete(run); };
  }
}

export class ObservableMap<K, V> {
  private map = new Map<K, V>();
  private subscribers = new Set<(value: ObservableMap<K, V>) => void>();

  constructor(private equals: Equality<V> = Object.is) {}

  get value(): ObservableMap<K, V> {
    return this;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  values(): V[] {
    return [...this.map.values()];
  }

  set(key: K, value: V): void {
    const previous = this.map.get(key);
    if (this.map.has(key) && this.equals(previous as V, value)) return;
    this.map.set(key, value);
    this.notify();
  }

  delete(key: K): void {
    if (this.map.delete(key)) this.notify();
  }

  reset(entries: Iterable<readonly [K, V]>): void {
    this.map = new Map(entries);
    this.notify();
  }

  subscribe(run: (value: ObservableMap<K, V>) => void): Unsubscriber {
    this.subscribers.add(run);
    run(this);
    return () => { this.subscribers.delete(run); };
  }

  private notify(): void {
    for (const run of [...this.subscribers]) run(this);
  }
}
```

`subscribe` delivers the current value before returning, then delivers every
change. That makes both classes valid Svelte stores. An imperative view can
keep the returned unsubscriber and refresh itself from the same callback.

Use field equality for user records so duplicate deliveries do not repaint the
UI:

```ts
import type { User } from "./relay-plugin-api";

const sameUser = (left: User, right: User): boolean =>
  left.id === right.id &&
  left.name === right.name &&
  left.picture === right.picture &&
  left.color === right.color;
```

## Connect to Relay

Install all event listeners and take both snapshots in one synchronous call.
Do not put an `await` between these operations: workspace events are ordered
and non-replayed.

```ts
import type { App, Plugin } from "obsidian";
import type { RelayEvent, User } from "./relay-plugin-api";

class RelayIdentities {
  readonly users = new ObservableMap<string, User>(sameUser);
  readonly currentUser = new ObservableValue<User | null>(
    null,
    (left, right) =>
      left === right ||
      (left !== null && right !== null && sameUser(left, right)),
  );

  constructor(private app: App) {}

  connect(plugin: Plugin): void {
    plugin.registerEvent(
      this.app.workspace.on("system3-relay:api-ready", () => {
        this.takeSnapshots();
      }),
    );
    plugin.registerEvent(
      this.app.workspace.on("system3-relay:v0:users", (event) => {
        this.applyUser(event);
      }),
    );
    plugin.registerEvent(
      this.app.workspace.on("system3-relay:v0:current-user", (event) => {
        this.applyCurrentUser(event);
      }),
    );
    this.takeSnapshots();
  }

  private takeSnapshots(): void {
    const api = getRelayApi(this.app);
    if (!api) return;
    try {
      this.users.reset(api.getUsers().map((user) => [user.id, user]));
      this.currentUser.set(api.getCurrentUser());
    } catch {
      // Relay may have unloaded after registry resolution. Keep local state and
      // reconcile from a fresh API after the next api-ready signal.
    }
  }

  private applyUser(event: RelayEvent<User>): void {
    if (event.action === "delete") {
      this.users.delete(event.record.id);
    } else {
      this.users.set(event.record.id, event.record);
    }
  }

  private applyCurrentUser(event: RelayEvent<User | null>): void {
    this.currentUser.set(
      event.action === "delete" ? null : event.record,
    );
  }
}
```

> Keep your last-known records when Relay is unavailable. A stale API throws,
> but records already copied into your stores remain valid. The next
> `api-ready` signal gives you a fresh API and snapshots reconcile the stores.

The identity channels are:

| Data | Snapshot | Event |
| --- | --- | --- |
| Known users | `getUsers(): User[]` | `system3-relay:v0:users` |
| Signed-in user | `getCurrentUser(): User \| null` | `system3-relay:v0:current-user` |

Each event contains `{ action, record }`. Actions are `create`, `update`, or
`delete`; every non-null record is complete rather than a partial patch. Apply
records idempotently by key.

## Register your text view

Register a `TextFileView` type so Relay sends collaborative changes through
that view instead of treating its file as an opaque disk update:

```ts
const registerRelayView = (): void => {
  getRelayApi(this.app)?.registerTextView(this.manifest.id, MY_VIEW_TYPE);
};

registerRelayView();
this.registerEvent(
  this.app.workspace.on("system3-relay:api-ready", registerRelayView),
);
this.register(() => {
  getRelayApi(this.app)?.unregisterTextView(this.manifest.id, MY_VIEW_TYPE);
});
```

`registerTextView` and `unregisterTextView` are symmetric, idempotent calls.
Neither returns a handle. Relay persists registrations so restored leaves can
attach during startup, refreshes open matching leaves when registration changes,
and removes a stored registration when its view type no longer exists.

### Round-trip the text you receive

Relay writes a remote change with `setViewData(text, false)` and reads local
saves with `getViewData()`. Render from the same value that `getViewData()`
returns:

```ts
class MyView extends TextFileView {
  setViewData(data: string, clear: boolean): void {
    this.data = data;
    this.render();
  }

  getViewData(): string {
    return this.data;
  }
}
```

> Return the exact text your view owns. Rendering from a second state object can
> display stale content and write that stale content back on the next save.

Relay suppresses an exact repeated `setViewData(text, false)` after the view has
adopted or locally submitted that text. Relay always delivers
`setViewData(text, true)` because `clear` resets state for a file load.

### Save local changes

Update and render the text returned by `getViewData()`, then call
`requestSave()` once:

```ts
update(next: string): void {
  this.data = next;
  this.render();
  this.requestSave();
}
```

`requestSave()` submits the text to Relay's merge machinery and schedules the
owning `TextFileView` save. Do not call `save()` after `requestSave()`; that
creates a second write path for the same edit.
