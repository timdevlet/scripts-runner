// Shared log backlog for the Logs view: the pre-window history and the live stream merged,
// deduped by entry id and capped. Framework-free (React binds via hooks/useLogs) so it's
// unit-testable in the node vitest env like the other stores.

import type { LogEntry } from "../types";
import { api } from "./api";
import { createStore } from "./createStore";

// Bound the rendered backlog: the daemon logs sparsely, so in practice this never trims, but a
// runaway stream can't grow the DOM forever (the vanilla UI appended nodes unbounded). `count`
// keeps counting past the cap — it's a separate counter, not entries.length.
const MAX_RENDERED_LINES = 5000;

export interface LogSnapshot {
  entries: LogEntry[];
  count: number;
}

// The slice of the preload bridge the store needs, injected so tests can drive it without IPC.
export interface LogSource {
  onLog(cb: (entry: LogEntry) => void): () => void;
  getHistory(): Promise<LogEntry[]>;
  clearHistory(): void;
}

export function createLogStore(source: LogSource, maxRenderedLines = MAX_RENDERED_LINES) {
  const store = createStore<LogSnapshot>({ entries: [], count: 0 });
  // Each entry carries a monotonic id from the main process. The history backlog and the live
  // onLog stream can overlap (a line logged right as the window opens lands in both), so dedupe
  // by id to render every line exactly once — which also makes StrictMode's doubled dev effect
  // (start/stop/start, history fetched twice) harmless.
  const seenIds = new Set<number>();

  function append(entry: LogEntry): void {
    if (seenIds.has(entry.id)) return;
    seenIds.add(entry.id);
    const prev = store.getSnapshot();
    let entries: LogEntry[];
    if (prev.entries.length >= maxRenderedLines) {
      const dropped = prev.entries.slice(0, prev.entries.length - maxRenderedLines + 1);
      // Forget trimmed ids too, so a chatty daemon can't grow the dedup set forever. The dedup
      // only guards the history/live overlap around window open — an id that old never recurs.
      for (const d of dropped) seenIds.delete(d.id);
      entries = [...prev.entries.slice(prev.entries.length - maxRenderedLines + 1), entry];
    } else {
      entries = [...prev.entries, entry];
    }
    store.emit({ entries, count: prev.count + 1 });
  }

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    // Subscribe to the live stream BEFORE fetching history so a line logged in the gap isn't
    // lost; the id dedupe renders any overlap between the two sources only once. Returns stop;
    // a stopped session's late history result is discarded.
    start(): () => void {
      let alive = true;
      const unsubscribe = source.onLog((entry) => {
        if (alive) append(entry);
      });
      void source.getHistory().then((history) => {
        if (alive) history.forEach(append);
      });
      return () => {
        alive = false;
        unsubscribe();
      };
    },
    // Optimistic: wipe the UI immediately; the main-process backlog clears fire-and-forget.
    clear(): void {
      source.clearHistory();
      seenIds.clear();
      store.emit({ entries: [], count: 0 });
    },
  };
}

export const logStore = createLogStore(api);
