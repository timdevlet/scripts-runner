// Shared update state (or null while up to date) — cached across mounts and kept live via the
// main process's update:state pushes, so a download that starts in Settings keeps reporting
// progress even if the view is closed and reopened. React binds via hooks/useUpdate.

import type { UpdateState } from "../types";
import { api } from "./api";
import { createStore } from "./createStore";

type UpdateCheckResult = Awaited<ReturnType<typeof api.checkForUpdate>>;

export function createUpdateStore(deps: {
  check: () => Promise<UpdateCheckResult>;
  onState: (cb: (state: UpdateState) => void) => () => void;
}) {
  const store = createStore<UpdateState | null>(null);
  // Coalesces the concurrent fetches StrictMode's doubled effect would otherwise make.
  let inflight: Promise<void> | null = null;
  // Subscribe to the main process's push exactly once, for the app's lifetime — this module
  // outlives every view, so there is nothing to tear down.
  let subscribed = false;

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    // On consumer mount: hook up the push once and kick the initial check if none has landed.
    // A failed check just means no button — dropping the handle (only if it's still ours) lets
    // the next mount retry; the main process's periodic re-check also covers us.
    ensureStarted(): void {
      if (!subscribed) {
        subscribed = true;
        deps.onState((state) => store.emit(state));
      }
      if (!store.getSnapshot() && !inflight) {
        const fetch: Promise<void> = deps.check().then(
          (result) => {
            if (inflight === fetch) inflight = null;
            if (result.ok && result.update) store.emit(result.update);
          },
          () => {
            if (inflight === fetch) inflight = null;
          },
        );
        inflight = fetch;
      }
    },
  };
}

export const updateStore = createUpdateStore({
  check: api.checkForUpdate,
  onState: api.onUpdateState,
});
