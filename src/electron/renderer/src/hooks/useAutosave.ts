import { useCallback, useEffect, useRef } from "react";

const AUTOSAVE_DEBOUNCE_MS = 400;

// Debounced autosave of a draft, shared by the Commands and Scripts tabs (neither has a Save
// button). `value` is written AUTOSAVE_DEBOUNCE_MS after it last changed, except:
//
//  • before `ready` (the initial load hasn't landed) and for the first value after it — that is
//    what was just read from disk, not an edit;
//  • for a value announced with adopt() — one the main process pushed (the scripts folder setting
//    changed), which must not come straight back as a write into the folder we just arrived at;
//  • while `paused` — the stored file couldn't be read, and the tab must not write over it.
//
// flush() runs the pending write right away: before an action that depends on it (▶ runs the
// STORED command, so the draft has to land first) and on unmount, so an edit made just before
// switching tabs isn't lost. Each edit is written at most once — a flush cancels the timer, and a
// skipped value drops whatever was pending, so a stale draft can never be flushed later.
export function useAutosave<T>(
  value: T,
  write: (value: T) => Promise<void>,
  { ready, paused }: { ready: boolean; paused: boolean },
): { flush: () => Promise<void>; adopt: () => void } {
  const pending = useRef<(() => Promise<void>) | null>(null);
  const skipNext = useRef(true);

  useEffect(() => {
    if (!ready) return;
    if (skipNext.current || paused) {
      skipNext.current = false;
      pending.current = null;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = async (): Promise<void> => {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.current = null;
      await write(value);
    };
    pending.current = save;
    timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [value, ready]);

  // Reads a ref, so it always runs the latest pending write — and can stay stable across renders.
  const flush = useCallback((): Promise<void> => pending.current?.() ?? Promise.resolve(), []);
  // Unmount only: flush is stable, and listing it would re-run this every render anyway.
  useEffect(() => () => void flush(), []);

  const adopt = useCallback((): void => {
    skipNext.current = true;
  }, []);

  return { flush, adopt };
}
