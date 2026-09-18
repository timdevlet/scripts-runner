// "Edit in VS Code" for the Scripts tab: the IPC wiring around src/os/edit-sessions.ts.
//
// The session machinery (temp file, watcher, close) lives there; this module supplies the VS Code
// launcher, names the file after the script, and turns the callbacks into renderer events. A save
// in VS Code reaches the tab as an ordinary source edit, so it autosaves like anything typed
// in-app.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import type { JsScript } from "../domain/js-script.js";
import { jsScriptLabel } from "../domain/js-script.js";
import { log, logError } from "../log.js";
import { createEditSessions } from "../os/edit-sessions.js";
import { openInVsCode } from "../os/external-editor.js";
import { primeLoginShell } from "../os/run-command.js";

const EDIT_DIR = join(tmpdir(), "command-scheduler-edit");

export interface ScriptEditResult {
  ok: boolean;
  // Absolute path of the file VS Code was given.
  path?: string;
  error?: string;
}

// Something usable as a filename, so the VS Code tab is named after the script rather than a uuid.
export function editFileName(script: Pick<JsScript, "id" | "name" | "source">): string {
  const slug = jsScriptLabel(script)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "script"}-${script.id.slice(0, 8)}.js`;
}

export interface ScriptEditBridge {
  // Ids of the scripts open in VS Code right now. The Scripts tab asks on every mount: it is
  // remounted each time the tab is visited, and the sessions outlive it.
  openIds(): string[];
  dispose(): void;
}

export function installScriptEditIpc(deps: {
  getWindow: () => BrowserWindow | null;
  getScript: (id: string) => JsScript | null;
}): ScriptEditBridge {
  const send = (channel: string, payload: unknown): void => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // The PATH a terminal would have, so `code` is found the way it is there. Resolved once, and
  // already primed by the scheduler's own startup, so this never actually waits.
  let editorPath = process.env.PATH ?? "";
  void primeLoginShell().then((value) => {
    editorPath = value ?? process.env.PATH ?? "";
  });

  const sessions = createEditSessions({
    dir: EDIT_DIR,
    open: (file) => openInVsCode(file, editorPath),
    onSource: (id, source) => send("scripts:edit-source", { id, source }),
    onState: (id, open) => send("scripts:edit-state", { id, open }),
    onError: (message) => logError(`External edit: ${message}`),
  });

  ipcMain.handle("scripts:edit", (_e, scriptId: unknown): ScriptEditResult => {
    if (typeof scriptId !== "string") return { ok: false, error: "Unknown script." };
    const script = deps.getScript(scriptId);
    if (!script) return { ok: false, error: "Unknown script." };

    const result = sessions.open(scriptId, editFileName(script), script.source);
    if (!result.ok) return result;
    if (!result.reopened) {
      log(`Editing "${jsScriptLabel(script)}" in VS Code — saves come back to the app.`);
    }
    return { ok: true, path: result.path };
  });

  return {
    openIds: () => sessions.openIds(),
    dispose() {
      sessions.dispose();
      ipcMain.removeHandler("scripts:edit");
    },
  };
}
