// IPC bridge for the Commands and Scripts tabs (the scheduler). Kept out of main.ts because it
// owns a fair bit on its own: the live scheduler, the debounced push of its state to the renderer,
// and the export/import file dialogs.
//
// Installed only when the `enableScheduler` feature flag is on — with the flag off, none of these
// channels exist and nothing can run a shell command.

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { type BrowserWindow, dialog, ipcMain } from "electron";
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
import { jsScriptsPath, loadJsScripts, saveJsScripts } from "../js-script-store.js";
import { log, logError } from "../log.js";
import { primeLoginShell } from "../os/run-command.js";
import {
  loadScheduledCommands,
  saveScheduledCommands,
  scheduledCommandsPath,
} from "../scheduled-store.js";
import { createScheduler, type Scheduler } from "../scheduler.js";

// Snapshot pushes are coalesced: a chatty command emits a line at a time, and the renderer only
// needs to repaint at human speed.
const PUSH_INTERVAL_MS = 200;

// How many upcoming firing times the cron preview returns.
const PREVIEW_RUNS = 3;

const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];

export interface SchedulerBridge {
  // Stop ticking, kill live runs, and drop the IPC handlers (app quit).
  dispose(): void;
}

export async function installSchedulerIpc(
  getWindow: () => BrowserWindow | null,
): Promise<SchedulerBridge> {
  const scheduler: Scheduler = createScheduler();

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

  let scriptsLoadError = "";
  try {
    scheduler.setScripts(await loadJsScripts());
  } catch (err) {
    scriptsLoadError = `Could not read "${jsScriptsPath()}": ${errorText(err)}`;
    logError(`${scriptsLoadError} — the Scripts tab is read-only until it's fixed or removed.`);
  }

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
    typeof commandId === "string"
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

  ipcMain.handle("scheduler:export", async () => {
    const win = getWindow();
    const options = {
      title: "Export commands",
      defaultPath: "scheduled-commands.json",
      filters: JSON_FILTERS,
    };
    // Passing the window makes the dialog a sheet on macOS; without one (window closed to the
    // tray) it opens standalone rather than not at all.
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath)
      return { ok: false as const, cancelled: true as const };
    try {
      await writeFile(result.filePath, serializeScheduleFile(scheduler.commands()), "utf8");
      log(`Exported ${scheduler.commands().length} command(s) to "${result.filePath}".`);
      return { ok: true as const, path: basename(result.filePath) };
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

  // Import hands the parsed commands back to the renderer rather than writing them itself, so the
  // tab can merge them into its draft (and autosave) like any other edit. Two safety measures,
  // because an imported file is a list of shell commands from somewhere else: every entry comes
  // back DISABLED so nothing starts running before it's been read, and every id is regenerated so
  // an import can't overwrite an existing command.
  ipcMain.handle("scheduler:import", async () => {
    const win = getWindow();
    const options = {
      title: "Import commands",
      properties: ["openFile" as const],
      filters: JSON_FILTERS,
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const file = result.filePaths[0];
    if (result.canceled || !file) return { ok: false as const, cancelled: true as const };
    try {
      const parsed = parseScheduleFile(JSON.parse(await readFile(file, "utf8")));
      const commands: ScheduledCommand[] = parsed.map((cmd) => ({
        ...cmd,
        id: globalThis.crypto.randomUUID(),
        enabled: false,
      }));
      log(
        `Imported ${commands.length} command(s) from "${file}" — disabled until you enable them.`,
      );
      return { ok: true as const, commands };
    } catch (err) {
      return { ok: false as const, error: `Could not read that file: ${errorText(err)}` };
    }
  });

  ipcMain.handle("scripts:list", () => ({
    ok: !scriptsLoadError,
    error: scriptsLoadError,
    scripts: scheduler.scripts(),
    snapshot: scheduler.snapshot(),
  }));

  ipcMain.handle("scripts:save", async (_e, payload: unknown) => {
    if (scriptsLoadError) return { ok: false as const, error: scriptsLoadError };
    const scripts = normalizeJsScripts(payload);
    try {
      await saveJsScripts(scripts);
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

  ipcMain.handle("scripts:export", async () => {
    const win = getWindow();
    const options = {
      title: "Export scripts",
      defaultPath: "js-scripts.json",
      filters: JSON_FILTERS,
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath)
      return { ok: false as const, cancelled: true as const };
    try {
      await writeFile(result.filePath, serializeJsScriptFile(scheduler.scripts()), "utf8");
      log(`Exported ${scheduler.scripts().length} script(s) to "${result.filePath}".`);
      return { ok: true as const, path: basename(result.filePath) };
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

  ipcMain.handle("scripts:import", async () => {
    const win = getWindow();
    const options = {
      title: "Import scripts",
      properties: ["openFile" as const],
      filters: JSON_FILTERS,
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const file = result.filePaths[0];
    if (result.canceled || !file) return { ok: false as const, cancelled: true as const };
    try {
      const parsed = parseJsScriptFile(JSON.parse(await readFile(file, "utf8")));
      const scripts: JsScript[] = parsed.map((row) => ({
        ...row,
        id: globalThis.crypto.randomUUID(),
        enabled: false,
      }));
      log(`Imported ${scripts.length} script(s) from "${file}" — disabled until you enable them.`);
      return { ok: true as const, scripts };
    } catch (err) {
      return { ok: false as const, error: `Could not read that file: ${errorText(err)}` };
    }
  });

  return {
    dispose() {
      unsubscribe();
      if (pushTimer) clearTimeout(pushTimer);
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
        "scripts:list",
        "scripts:save",
        "scripts:run",
        "scripts:stop",
        "scripts:export",
        "scripts:import",
      ]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}
