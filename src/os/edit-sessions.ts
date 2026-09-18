// Round-tripping a piece of text through an external editor.
//
// The app edits text it holds in memory, so editing it externally means giving it a file to be:
// the text is written to a temp file, an editor is pointed at it, and every save is read back and
// handed to `onSource`. The session ends when the editor says the file is closed — the watcher
// stops and the temp file goes. (A JS script does have a script.js of its own on disk, but the
// unsaved buffer in the app is what gets edited, not whatever was last written out.)
//
// Sync is deliberately one-way (file -> app). Two-way would mean racing the user's keystrokes in
// two editors over one buffer; the caller warns in its UI instead.
//
// No Electron here: the editor launcher and the callbacks are injected, so this is driven directly
// by the tests.

import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { EditorSession } from "./external-editor.js";

// A save is one action to the user but can surface as several watch events.
const DEFAULT_COALESCE_MS = 120;

export interface EditSessionsDeps {
  // Folder the temp files live in. Created on demand.
  dir: string;
  // Launch the editor on `file`. The returned session resolves when the file is closed there.
  open: (file: string) => EditorSession | { error: string };
  // A save in the editor: the file's new content.
  onSource: (id: string, source: string) => void;
  // A session started (true) or ended (false).
  onState: (id: string, open: boolean) => void;
  // Background failures — a dead watcher, a launcher that exited badly.
  onError?: (message: string) => void;
  coalesceMs?: number;
}

export type OpenResult =
  | { ok: true; path: string; reopened: boolean }
  | { ok: false; error: string };

interface Session {
  id: string;
  file: string;
  // What we last wrote or read, so a watch event that changed nothing is dropped and our own
  // initial write never bounces back as an edit.
  seen: string;
  timer: NodeJS.Timeout | null;
}

export interface EditSessions {
  // Write `source` to `<dir>/<fileName>` and open it. Opening an id that already has a session
  // just re-launches the editor on the same file, leaving its content (and anything unsaved in
  // it) alone.
  open(id: string, fileName: string, source: string): OpenResult;
  isOpen(id: string): boolean;
  // Every id with a session open right now.
  openIds(): string[];
  // End every session: stop watching, drop the temp files. Nothing is read back.
  dispose(): void;
}

export function createEditSessions(deps: EditSessionsDeps): EditSessions {
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
  const sessions = new Map<string, Session>();
  let watcher: ReturnType<typeof watch> | null = null;

  const removeFile = (file: string): void => {
    try {
      rmSync(file, { force: true });
    } catch {
      // A leftover file in the OS temp folder is harmless.
    }
  };

  // Read the file and report it upwards if it actually changed.
  const sync = (session: Session): void => {
    let source: string;
    try {
      source = readFileSync(session.file, "utf8");
    } catch {
      // Saved-then-deleted, or we caught the editor mid-rename — the next save wins.
      return;
    }
    if (source === session.seen) return;
    session.seen = source;
    deps.onSource(session.id, source);
  };

  // One watcher over the whole folder, not one per file: an editor that saves by rename (write a
  // temp file, move it into place) destroys a watch on the file itself, but the directory keeps
  // reporting.
  const ensureWatcher = (): void => {
    if (watcher) return;
    watcher = watch(deps.dir, (_event, filename) => {
      if (!filename) return;
      const name = basename(filename.toString());
      const session = [...sessions.values()].find((s) => basename(s.file) === name);
      if (!session) return;
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = null;
        sync(session);
      }, coalesceMs);
    });
    watcher.on("error", (err) => deps.onError?.(`Watching the edited file failed: ${err.message}`));
  };

  const end = (session: Session, { finalRead }: { finalRead: boolean }): void => {
    if (session.timer) clearTimeout(session.timer);
    // The last save can land in the same instant the editor closes; read once more before the
    // file goes, so nothing typed is silently dropped.
    if (finalRead) sync(session);
    sessions.delete(session.id);
    removeFile(session.file);
    if (sessions.size === 0) {
      watcher?.close();
      watcher = null;
    }
    deps.onState(session.id, false);
  };

  return {
    isOpen: (id) => sessions.has(id),
    openIds: () => [...sessions.keys()],

    open(id, fileName, source) {
      const existing = sessions.get(id);
      const file = existing?.file ?? join(deps.dir, fileName);
      try {
        mkdirSync(deps.dir, { recursive: true });
        if (!existing) writeFileSync(file, source, "utf8");
      } catch (err) {
        return { ok: false, error: `Could not write the file to edit: ${(err as Error).message}` };
      }

      const launched = deps.open(file);
      if ("error" in launched) {
        if (!existing) removeFile(file);
        return { ok: false, error: launched.error };
      }
      if (existing) return { ok: true, path: file, reopened: true };

      const session: Session = { id, file, seen: source, timer: null };
      sessions.set(id, session);
      ensureWatcher();
      deps.onState(id, true);

      void launched.closed.then((error) => {
        if (error) deps.onError?.(error);
        // Only end the session we started — it may already have been replaced.
        if (sessions.get(id) === session) end(session, { finalRead: !error });
      });

      return { ok: true, path: file, reopened: false };
    },

    dispose() {
      for (const session of [...sessions.values()]) end(session, { finalRead: false });
      watcher?.close();
      watcher = null;
    },
  };
}
