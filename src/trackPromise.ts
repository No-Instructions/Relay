declare const BUILD_TYPE: string;

interface TrackedEntry {
  label: string;
  created: number;
  owner?: string;
}

export interface CompletedEntry {
  label: string;
  created: number;
  settledAt: number;
  state: "fulfilled" | "rejected";
  owner?: string;
}

// Module-level ring buffer of recent completions. Survives plugin reload so
// completed promises from a prior instance remain inspectable.
const RECENT_CAPACITY = 100;
const _recent: CompletedEntry[] = [];

function recordSettled(entry: TrackedEntry, state: "fulfilled" | "rejected"): void {
  _recent.push({
    label: entry.label,
    created: entry.created,
    settledAt: Date.now(),
    state,
    owner: entry.owner,
  });
  if (_recent.length > RECENT_CAPACITY) {
    _recent.shift();
  }
}

export class PromiseTracker {
  private tracked = new Map<number, TrackedEntry>();
  private nextId = 0;
  private defaultOwner?: string;

  constructor(defaultOwner?: string) {
    this.defaultOwner = defaultOwner;
  }

  setDefaultOwner(owner: string | undefined): void {
    this.defaultOwner = owner;
  }

  track<T>(label: string, p: Promise<T>, owner?: string): Promise<T> {
    if (BUILD_TYPE !== "debug") return p;
    const id = this.nextId++;
    const entry: TrackedEntry = {
      label,
      created: Date.now(),
      owner: owner ?? this.defaultOwner,
    };
    this.tracked.set(id, entry);
    p.then(
      () => {
        if (this.tracked.delete(id)) recordSettled(entry, "fulfilled");
      },
      () => {
        if (this.tracked.delete(id)) recordSettled(entry, "rejected");
      },
    );
    return p;
  }

  getPending(): { label: string; ageMs: number; owner?: string }[] {
    const now = Date.now();
    return [...this.tracked.values()].map((v) => ({
      label: v.label,
      ageMs: now - v.created,
      owner: v.owner,
    }));
  }

  destroy(): void {
    this.tracked.clear();
  }
}

let _active: PromiseTracker | null = null;

export function setActiveTracker(tracker: PromiseTracker | null): void {
  _active = tracker;
}

export function trackPromise<T>(label: string, p: Promise<T>, owner?: string): Promise<T> {
  return _active ? _active.track(label, p, owner) : p;
}

export function getRecentPromises(): CompletedEntry[] {
  return [..._recent];
}
