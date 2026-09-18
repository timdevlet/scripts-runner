import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../../../../domain/errors";
import { api } from "../stores/api";
import type { ScheduledCommand, SchedulerSnapshot } from "../types";
import { useAutosave } from "./useAutosave";

const EMPTY_SNAPSHOT: SchedulerSnapshot = { runs: [], running: [], nextRunAt: {} };

// The Commands tab's state: the command list as a local draft (autosaved, like the Settings form —
// there is no Save button) plus the live scheduler snapshot pushed from the main process.
//
// The two halves come from opposite directions on purpose. The draft is owned here so typing is
// never interrupted by a round-trip; the snapshot (what's running, when things fire next, the run
// history) is owned by the main process, which is the only thing that actually knows.
export function useScheduler() {
  const [commands, setCommands] = useState<ScheduledCommand[]>([]);
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot>(EMPTY_SNAPSHOT);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Set when the stored file couldn't be read: the tab must not autosave over it.
  const readOnly = useRef(false);

  // Initial load + the live snapshot subscription. Subscribe BEFORE loading so an update that
  // lands in the gap isn't missed.
  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onSchedulerUpdate((next) => {
      if (alive) setSnapshot(next);
    });
    api.getScheduledCommands().then(
      (result) => {
        if (!alive) return;
        readOnly.current = !result.ok;
        setCommands(result.commands);
        setSnapshot(result.snapshot);
        setError(result.error);
        setLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        readOnly.current = true;
        setError(errorText(err));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const { flush } = useAutosave(
    commands,
    async (list) => {
      try {
        const result = await api.saveScheduledCommands(list);
        setError(result.ok ? "" : result.error);
      } catch (err) {
        setError(errorText(err));
      }
    },
    { ready: !loading, paused: readOnly.current },
  );

  const update = useCallback((id: string, patch: Partial<ScheduledCommand>) => {
    setCommands((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const add = useCallback((command: ScheduledCommand) => {
    setCommands((list) => [...list, command]);
  }, []);

  const remove = useCallback((id: string) => {
    setCommands((list) => list.filter((c) => c.id !== id));
  }, []);

  const append = useCallback((imported: ScheduledCommand[]) => {
    setCommands((list) => [...list, ...imported]);
  }, []);

  return {
    commands,
    snapshot,
    error,
    loading,
    readOnly: readOnly.current,
    add,
    remove,
    update,
    append,
    flush,
    setError,
  };
}
