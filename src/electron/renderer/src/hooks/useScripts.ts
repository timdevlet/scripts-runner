import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../../../../domain/errors";
import { api } from "../stores/api";
import type { JsScript, SchedulerSnapshot } from "../types";

const AUTOSAVE_DEBOUNCE_MS = 400;

const EMPTY_SNAPSHOT: SchedulerSnapshot = { runs: [], running: [], nextRunAt: {} };

// The Scripts tab's state: the script list as a local draft (autosaved, like Commands — there is
// no Save button) plus the live scheduler snapshot pushed from the main process.
export function useScripts() {
  const [scripts, setScripts] = useState<JsScript[]>([]);
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot>(EMPTY_SNAPSHOT);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Ids currently open in VS Code (see src/electron/script-edit.ts) — the panel says so, because
  // while a session is open the external file, not the in-app editor, is what the next save wins
  // with.
  const [editingExternally, setEditingExternally] = useState<string[]>([]);
  const readOnly = useRef(false);
  // A list pushed from the main process (the scripts folder setting changed) is not an edit, so
  // it must not come straight back as an autosave — that would write the folder we just left
  // into the folder we just arrived at.
  const adopting = useRef(false);

  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onSchedulerUpdate((next) => {
      if (alive) setSnapshot(next);
    });
    // A save in VS Code lands here as a normal source edit, so it autosaves like any other.
    const unsubscribeSource = api.onJsScriptEditSource(({ id, source }) => {
      if (alive) setScripts((list) => list.map((s) => (s.id === id ? { ...s, source } : s)));
    });
    // The scripts folder changed under us: the main process has re-read it and sent the result.
    const unsubscribeReloaded = api.onJsScriptsReloaded((result) => {
      if (!alive) return;
      adopting.current = true;
      readOnly.current = !result.ok;
      setScripts(result.scripts);
      setSnapshot(result.snapshot);
      setError(result.error);
    });
    const unsubscribeState = api.onJsScriptEditState(({ id, open }) => {
      if (!alive) return;
      setEditingExternally((ids) =>
        open ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id),
      );
    });
    api.getJsScripts().then(
      (result) => {
        if (!alive) return;
        readOnly.current = !result.ok;
        setScripts(result.scripts);
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
      unsubscribeSource();
      unsubscribeReloaded();
      unsubscribeState();
    };
  }, []);

  const pending = useRef<(() => Promise<void>) | null>(null);
  const skipInitial = useRef(true);

  useEffect(() => {
    if (loading || skipInitial.current) {
      if (!loading) skipInitial.current = false;
      return;
    }
    if (adopting.current) {
      adopting.current = false;
      return;
    }
    if (readOnly.current) return;
    const save = async (): Promise<void> => {
      pending.current = null;
      try {
        const result = await api.saveJsScripts(scripts);
        setError(result.ok ? "" : result.error);
      } catch (err) {
        setError(errorText(err));
      }
    };
    pending.current = save;
    const timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [scripts, loading]);

  const flush = useCallback((): Promise<void> => pending.current?.() ?? Promise.resolve(), []);
  useEffect(() => () => void flush(), []);

  const update = useCallback((id: string, patch: Partial<JsScript>) => {
    setScripts((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const add = useCallback((script: JsScript) => {
    setScripts((list) => [...list, script]);
  }, []);

  const remove = useCallback((id: string) => {
    setScripts((list) => list.filter((s) => s.id !== id));
  }, []);

  const append = useCallback((imported: JsScript[]) => {
    setScripts((list) => [...list, ...imported]);
  }, []);

  return {
    scripts,
    snapshot,
    error,
    loading,
    editingExternally,
    readOnly: readOnly.current,
    add,
    remove,
    update,
    append,
    flush,
    setError,
  };
}
