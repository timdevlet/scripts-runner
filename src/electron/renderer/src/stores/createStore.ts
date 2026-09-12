// The snapshot + listeners skeleton every renderer store shares: getSnapshot/subscribe for
// React's useSyncExternalStore, emit to replace the snapshot and notify. Framework-free so the
// stores stay unit-testable in the node vitest env.

export interface Store<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  // Replace the snapshot and notify every subscriber. Snapshots are replaced, never mutated, so
  // useSyncExternalStore sees a new reference exactly when something changed.
  emit(next: T): void;
}

export function createStore<T>(initial: T): Store<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (next) => {
      snapshot = next;
      for (const l of listeners) l();
    },
  };
}
