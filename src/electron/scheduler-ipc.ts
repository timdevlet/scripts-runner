// IPC bridge for the Commands and Scripts tabs (the scheduler). Kept out of main.ts because it
// owns a fair bit on its own: the live scheduler, the debounced push of its state to the renderer,
// and the export/import file dialogs.
//
// Installed only when the `enableScheduler` feature flag is on — with the flag off, none of these
// channels exist and nothing can run a shell command.

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  type BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from "electron";
import { cronError, describeCron, nextRuns } from "../domain/cron.js";
import { errorText } from "../domain/errors.js";
import {
  type JsScript,
  normalizeJsScripts,
  parseJsScriptFile,
  serializeJsScriptFile,
} from "../domain/js-script.js";
import {
  normalizeScheduledCommands,
  parseScheduleFile,
  type ScheduledCommand,
  serializeScheduleFile,
} from "../domain/scheduled.js";
import { secretNameError } from "../domain/secrets.js";
import {
  legacyJsScriptsPath,
  loadJsScripts,
  migrateLegacyJsScripts,
  resolveScriptsDir,
  saveJsScripts,
} from "../js-script-store.js";
import { log, logError } from "../log.js";
import { primeLoginShell } from "../os/run-command.js";
import {
  loadScheduledCommands,
  saveScheduledCommands,
  scheduledCommandsPath,
} from "../scheduled-store.js";
import { createScheduler, type Scheduler } from "../scheduler.js";
import { loadSecrets, saveSecrets, secretsPath } from "../secrets-store.js";
import { installScriptEditIpc } from "./script-edit.js";
import { getSettings } from "./settings.js";

// Snapshot pushes are coalesced: a chatty command emits a line at a time, and the renderer only
// needs to repaint at human speed.
const PUSH_INTERVAL_MS = 200;

// How many upcoming firing times the cron preview returns.
const PREVIEW_RUNS = 3;

const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];

export interface SchedulerBridge {
  // Re-read the scripts directory and push the result to the Scripts tab. Called when the user
  // points the scriptsDir setting somewhere else — nothing else would notice the folder the tab
  // is showing has changed underneath it.
  reloadScripts(): Promise<void>;
  // Stop ticking, kill live runs, and drop the IPC handlers (app quit).
  dispose(): void;
}

export async function installSchedulerIpc(
  getWindow: () => BrowserWindow | null,
): Promise<SchedulerBridge> {
  // The secret vault, held in the main process for the life of the app: runs read it through the
  // scheduler's `secrets` dep, and the renderer only ever learns which names exist. Same
  // read-only-on-failure rule as the other stores — a file we couldn't parse is never written
  // over, because doing so would drop every key in it.
  let secrets: Record<string, string> = {};
  let secretsError = "";
  try {
    secrets = await loadSecrets();
  } catch (err) {
    secretsError = `Could not read "${secretsPath()}": ${errorText(err)}`;
    logError(`${secretsError} — secrets are unavailable until it's fixed or removed.`);
  }

  const scheduler: Scheduler = createScheduler({ secrets: () => secrets });

  // Read the user's login-shell PATH once, before anything can run: commands then resolve `node`,
  // `python`, … the way a terminal would, without every run re-sourcing (and re-printing) the
  // shell profile. Awaited, so the very first run behaves like every later one.
  await primeLoginShell();

  // A malformed file must not start the app with an empty list that the first autosave then
  // writes over the user's commands. Remember the failure and report it to the tab instead.
  let loadError = "";
  try {
    scheduler.setCommands(await loadScheduledCommands());
  } catch (err) {
    loadError = `Could not read "${scheduledCommandsPath()}": ${errorText(err)}`;
    logError(`${loadError} — the Commands tab is read-only until it's fixed or removed.`);
  }

  // Where the scripts live. Held rather than re-resolved per call, so a save can never land in a
  // different folder than the load it came from; reloadScripts is what moves it.
  let scriptsDir = resolveScriptsDir((await getSettings()).scriptsDir);
  let scriptsLoadError = "";

  const readScripts = async (): Promise<void> => {
    scriptsLoadError = "";
    try {
      let scripts = await loadJsScripts(scriptsDir);
      // First run after the upgrade from the single js-scripts.json: only ever with an empty
      // directory, so the move can't overwrite folders that are already there.
      if (scripts.length === 0) {
        const moved = await migrateLegacyJsScripts(scriptsDir);
        if (moved > 0) {
          log(
            `Moved ${moved} script(s) from "${legacyJsScriptsPath()}" into "${scriptsDir}" — ` +
              "one folder each, holding script.js and script.json.",
          );
          scripts = await loadJsScripts(scriptsDir);
        }
      }
      scheduler.setScripts(scripts);
    } catch (err) {
      scriptsLoadError = `Could not read "${scriptsDir}": ${errorText(err)}`;
      logError(`${scriptsLoadError} — the Scripts tab is read-only until it's fixed or removed.`);
      // Empty, not stale: on a reload this folder is the one we just moved to, and leaving the
      // previous folder's scripts on screen (and its schedules armed) would be a lie. The tab is
      // read-only while the error stands, so nothing can be autosaved over.
      scheduler.setScripts([]);
    }
  };
  await readScripts();

  const armedCommands = scheduler.commands().filter((c) => c.enabled && c.cron.trim());
  const armedScripts = scheduler.scripts().filter((s) => s.enabled && s.cron.trim());
  const armed = armedCommands.length + armedScripts.length;
  log(
    armed === 0
      ? "Scheduler running — nothing is scheduled."
      : `Scheduler running — ${armed} scheduled item${armed === 1 ? "" : "s"}:`,
  );
  for (const cmd of armedCommands)
    log(`  ${describeCron(cmd.cron)} → "${cmd.name || cmd.command}"`);
  for (const script of armedScripts) {
    log(`  ${describeCron(script.cron)} → "${script.name || "script"}"`);
  }
  scheduler.start();

  // Debounced push of the scheduler's state to the renderer.
  let pushTimer: NodeJS.Timeout | null = null;
  const push = (): void => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send("scheduler:update", scheduler.snapshot());
    }, PUSH_INTERVAL_MS);
  };
  const unsubscribe = scheduler.subscribe(push);

  ipcMain.handle("scheduler:list", () => ({
    ok: !loadError,
    error: loadError,
    commands: scheduler.commands(),
    snapshot: scheduler.snapshot(),
  }));

  // Whole-list replace, like the settings autosave: the renderer always sends the complete list,
  // and an empty one means "every command deleted". Coerced here so a malformed payload can't
  // reach the runner.
  ipcMain.handle("scheduler:save", async (_e, payload: unknown) => {
    if (loadError) return { ok: false as const, error: loadError };
    const commands = normalizeScheduledCommands(payload);
    try {
      await saveScheduledCommands(commands);
    } catch (err) {
      return { ok: false as const, error: `Could not save commands: ${errorText(err)}` };
    }
    scheduler.setCommands(commands);
    return { ok: true as const };
  });

  ipcMain.handle("scheduler:run", (_e, commandId: unknown) =>
    typeof commandId === "string" && scheduler.commands().some((c) => c.id === commandId)
      ? scheduler.runNow(commandId)
      : { ok: false as const, error: "Unknown command." },
  );

  ipcMain.handle("scheduler:stop", (_e, commandId: unknown) => ({
    ok: typeof commandId === "string" ? scheduler.stop(commandId) : false,
  }));

  ipcMain.handle("scheduler:output", (_e, runId: unknown) =>
    typeof runId === "string" ? scheduler.output(runId) : [],
  );

  // Validate/describe a cron expression as it's typed. It runs through the very same parser the
  // scheduler fires from, so the preview can't disagree with the actual behavior.
  ipcMain.handle("scheduler:preview", (_e, expr: unknown) => {
    const text = typeof expr === "string" ? expr.trim() : "";
    if (!text) return { ok: true as const, error: "", description: "", next: [] as number[] };
    const error = cronError(text);
    if (error) return { ok: false as const, error, description: "", next: [] as number[] };
    return {
      ok: true as const,
      error: "",
      description: describeCron(text),
      next: nextRuns(text, new Date(), PREVIEW_RUNS).map((d) => d.getTime()),
    };
  });

  // Dialogs get the window when there is one — that makes them a sheet on macOS. Without one (the
  // window is closed to the tray) they open standalone rather than not at all.
  const openDialog = (options: OpenDialogOptions): Promise<OpenDialogReturnValue> => {
    const win = getWindow();
    return win && !win.isDestroyed()
      ? dialog.showOpenDialog(win, options)
      : dialog.showOpenDialog(options);
  };
  const saveDialog = (options: SaveDialogOptions): Promise<SaveDialogReturnValue> => {
    const win = getWindow();
    return win && !win.isDestroyed()
      ? dialog.showSaveDialog(win, options)
      : dialog.showSaveDialog(options);
  };

  // Native directory picker behind the "dir" script params and the working-directory fields.
  // Lives here with the other dialogs for the same reason: the renderer can't open one itself.
  // The current value only seeds defaultPath — the chosen path is the user's, so nothing the
  // renderer sends can reach the filesystem on its own.
  ipcMain.handle("dialog:pick-directory", async (_event, current: unknown) => {
    const result = await openDialog({
      title: "Choose a folder",
      properties: ["openDirectory", "createDirectory"],
      ...(typeof current === "string" && current.trim() !== ""
        ? { defaultPath: current.trim() }
        : {}),
    });
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return { ok: false as const, cancelled: true as const };
    return { ok: true as const, path: dir };
  });

  // Export / import for one of the two lists. The Commands and Scripts tabs share the dialogs and
  // the import rules: the parsed entries go back to the renderer rather than to disk, so the tab
  // merges them into its draft (and autosaves) like any other edit; every entry comes back
  // DISABLED, because an imported file is a list of commands from somewhere else and nothing
  // should start running before it's been read; and every id is regenerated so an import can't
  // overwrite an existing entry.
  function installTransfer<T extends { id: string; enabled: boolean }>(spec: {
    // IPC channel prefix: "<channel>:export" and "<channel>:import".
    channel: string;
    // The key the import result carries the entries under — what the renderer reads.
    key: "commands" | "scripts";
    // Singular, for the log line.
    noun: string;
    defaultPath: string;
    current: () => T[];
    serialize: (items: T[]) => string;
    parse: (value: unknown) => T[];
  }): void {
    ipcMain.handle(`${spec.channel}:export`, async () => {
      const result = await saveDialog({
        title: `Export ${spec.key}`,
        defaultPath: spec.defaultPath,
        filters: JSON_FILTERS,
      });
      if (result.canceled || !result.filePath) {
        return { ok: false as const, cancelled: true as const };
      }
      try {
        const items = spec.current();
        await writeFile(result.filePath, spec.serialize(items), "utf8");
        log(`Exported ${items.length} ${spec.noun}(s) to "${result.filePath}".`);
        return { ok: true as const, path: basename(result.filePath) };
      } catch (err) {
        return { ok: false as const, error: errorText(err) };
      }
    });

    ipcMain.handle(`${spec.channel}:import`, async () => {
      const result = await openDialog({
        title: `Import ${spec.key}`,
        properties: ["openFile"],
        filters: JSON_FILTERS,
      });
      const file = result.filePaths[0];
      if (result.canceled || !file) return { ok: false as const, cancelled: true as const };
      try {
        const items: T[] = spec.parse(JSON.parse(await readFile(file, "utf8"))).map((item) => ({
          ...item,
          id: globalThis.crypto.randomUUID(),
          enabled: false,
        }));
        log(
          `Imported ${items.length} ${spec.noun}(s) from "${file}" — disabled until you enable them.`,
        );
        return { ok: true as const, [spec.key]: items };
      } catch (err) {
        return { ok: false as const, error: `Could not read that file: ${errorText(err)}` };
      }
    });
  }

  installTransfer<ScheduledCommand>({
    channel: "scheduler",
    key: "commands",
    noun: "command",
    defaultPath: "scheduled-commands.json",
    current: () => scheduler.commands(),
    serialize: serializeScheduleFile,
    parse: parseScheduleFile,
  });

  // The whole vault, values included: Settings shows them in place, and a field holding a
  // {{NAME}} reference can reveal what it stands for. The path comes along for the Settings hint.
  const secretsResult = () => ({
    ok: !secretsError,
    error: secretsError,
    names: Object.keys(secrets).sort((a, b) => a.localeCompare(b)),
    values: { ...secrets },
    path: secretsPath(),
  });

  ipcMain.handle("secrets:list", () => secretsResult());

  ipcMain.handle("secrets:set", async (_e, payload: unknown) => {
    if (secretsError) return { ...secretsResult(), ok: false as const };
    const entry = typeof payload === "object" && payload !== null ? payload : {};
    const name = String((entry as { name?: unknown }).name ?? "").trim();
    const value = (entry as { value?: unknown }).value;
    const nameError = secretNameError(name);
    if (nameError) return { ...secretsResult(), ok: false as const, error: nameError };
    if (typeof value !== "string" || value === "") {
      return { ...secretsResult(), ok: false as const, error: "Give the secret a value." };
    }
    const existed = Object.hasOwn(secrets, name);
    const next = { ...secrets, [name]: value };
    try {
      await saveSecrets(next);
    } catch (err) {
      return {
        ...secretsResult(),
        ok: false as const,
        error: `Could not save secrets: ${errorText(err)}`,
      };
    }
    secrets = next;
    log(`Secret "${name}" was ${existed ? "updated" : "added"}.`);
    return secretsResult();
  });

  ipcMain.handle("secrets:remove", async (_e, payload: unknown) => {
    if (secretsError) return { ...secretsResult(), ok: false as const };
    const name = typeof payload === "string" ? payload : "";
    if (!Object.hasOwn(secrets, name)) return secretsResult();
    const next = { ...secrets };
    delete next[name];
    try {
      await saveSecrets(next);
    } catch (err) {
      return {
        ...secretsResult(),
        ok: false as const,
        error: `Could not save secrets: ${errorText(err)}`,
      };
    }
    secrets = next;
    log(`Secret "${name}" was removed.`);
    return secretsResult();
  });

  // The resolved absolute path, for the Settings field — the default is otherwise unknowable
  // from the renderer, which sees only the empty string that stands for it.
  ipcMain.handle("scripts:dir", () => scriptsDir);

  // "Edit in VS Code": its own module, but it reads scripts out of this scheduler and is torn
  // down with the rest of the scripts IPC.
  const scriptEdit = installScriptEditIpc({
    getWindow,
    getScript: (id) => scheduler.scripts().find((s) => s.id === id) ?? null,
  });

  // What the Scripts tab needs to draw itself — the initial list and a reload send the same thing.
  const scriptsResult = () => ({
    ok: !scriptsLoadError,
    error: scriptsLoadError,
    scripts: scheduler.scripts(),
    snapshot: scheduler.snapshot(),
    // Which scripts are open in VS Code. The tab is remounted on every visit and would otherwise
    // forget the sessions it started; the main process is what actually holds them.
    editing: scriptEdit.openIds(),
  });

  ipcMain.handle("scripts:list", () => scriptsResult());

  ipcMain.handle("scripts:save", async (_e, payload: unknown) => {
    if (scriptsLoadError) return { ok: false as const, error: scriptsLoadError };
    const scripts = normalizeJsScripts(payload);
    try {
      await saveJsScripts(scriptsDir, scripts);
    } catch (err) {
      return { ok: false as const, error: `Could not save scripts: ${errorText(err)}` };
    }
    scheduler.setScripts(scripts);
    return { ok: true as const };
  });

  ipcMain.handle("scripts:run", (_e, scriptId: unknown) => {
    if (typeof scriptId !== "string" || !scheduler.scripts().some((s) => s.id === scriptId)) {
      return { ok: false as const, error: "Unknown script." };
    }
    return scheduler.runNow(scriptId);
  });

  ipcMain.handle("scripts:stop", (_e, scriptId: unknown) => ({
    ok: typeof scriptId === "string" ? scheduler.stop(scriptId) : false,
  }));

  installTransfer<JsScript>({
    channel: "scripts",
    key: "scripts",
    noun: "script",
    defaultPath: "js-scripts.json",
    current: () => scheduler.scripts(),
    serialize: serializeJsScriptFile,
    parse: parseJsScriptFile,
  });

  return {
    async reloadScripts() {
      scriptsDir = resolveScriptsDir((await getSettings()).scriptsDir);
      log(`Scripts folder is now "${scriptsDir}".`);
      await readScripts();
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send("scripts:reloaded", scriptsResult());
    },

    dispose() {
      unsubscribe();
      if (pushTimer) clearTimeout(pushTimer);
      scriptEdit.dispose();
      scheduler.dispose();
      for (const channel of [
        "scheduler:list",
        "scheduler:save",
        "scheduler:run",
        "scheduler:stop",
        "scheduler:output",
        "scheduler:preview",
        "scheduler:export",
        "scheduler:import",
        "secrets:list",
        "secrets:set",
        "secrets:remove",
        "scripts:dir",
        "scripts:list",
        "scripts:save",
        "scripts:run",
        "scripts:stop",
        "scripts:export",
        "scripts:import",
        "dialog:pick-directory",
      ]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}
