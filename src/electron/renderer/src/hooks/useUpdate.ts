import { useEffect, useSyncExternalStore } from "react";
import { api } from "../stores/api";
import { updateStore } from "../stores/updateStore";
import type { UpdateState } from "../types";

// React binding for the shared update-state store (stores/updateStore.ts).

// The one action behind the update button; what it does follows the phase. Resolves to the error
// to show, or null. State transitions arrive via the update:state push, not from here.
async function act(): Promise<string | null> {
  const update = updateStore.getSnapshot();
  if (!update) return null;
  if (update.mode === "install" && update.phase === "downloaded") {
    const result = await api.installUpdate();
    return result.ok ? null : result.error;
  }
  if (update.phase === "available") {
    const result = await api.downloadUpdate();
    return result.ok ? null : result.error;
  }
  return null; // download in progress — nothing to do
}

// The matching button label. In browser mode the phase never leaves "available", so the label
// stays "Download update" and the click hands the file to the browser.
export function updateActionLabel(state: UpdateState): string {
  if (state.phase === "downloading") return `Downloading… ${state.percent}%`;
  if (state.phase === "downloaded") return "Restart to update";
  return "Download update";
}

interface UpdateHook {
  update: UpdateState | null;
  act: () => Promise<string | null>;
}

export function useUpdate(): UpdateHook {
  const update = useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot);
  useEffect(() => {
    updateStore.ensureStarted();
  }, []);
  return { update, act };
}
