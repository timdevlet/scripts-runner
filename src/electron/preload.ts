// Preload: the only bridge between the privileged main process and the sandboxed renderer.
// Exposes a tiny, explicit `window.appAPI` (contextIsolation is on, nodeIntegration off).

import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { JsScript } from "../domain/js-script.js";
import type { RunLine, ScheduledCommand, SchedulerSnapshot } from "../domain/scheduled.js";
import type { LogEntry } from "../log.js";
import type { AppSettings } from "./settings.js";

export type ScheduledCommandsResult = {
  // false when the stored file couldn't be read; the tab then shows `error` and stays read-only
  // rather than autosaving an empty list over it.
  ok: boolean;
  error: string;
  commands: ScheduledCommand[];
  snapshot: SchedulerSnapshot;
};
export type SchedulerSaveResult = { ok: true } | { ok: false; error: string };
export type SchedulerRunResult = { ok: boolean; error?: string };
export type CronPreview = { ok: boolean; error: string; description: string; next: number[] };
export type SchedulerExportResult =
  | { ok: true; path: string }
  | { ok: false; cancelled?: true; error?: string };
export type SchedulerImportResult =
  | { ok: true; commands: ScheduledCommand[] }
  | { ok: false; cancelled?: true; error?: string };
export type JsScriptsResult = {
  ok: boolean;
  error: string;
  scripts: JsScript[];
  snapshot: SchedulerSnapshot;
};
export type JsScriptsImportResult =
  | { ok: true; scripts: JsScript[] }
  | { ok: false; cancelled?: true; error?: string };
export type SettingsSaveResult = { ok: true } | { ok: false; error?: string };

const subscribe =
  <T>(channel: string) =>
  (cb: (payload: T) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  };
const subscribeVoid =
  (channel: string) =>
  (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  };

const appAPI = {
  onLog: subscribe<LogEntry>("log"),
  getHistory: (): Promise<LogEntry[]> => ipcRenderer.invoke("log:history"),
  clearHistory: (): void => ipcRenderer.send("log:clear"),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  saveSettings: (partial: Partial<AppSettings>): Promise<SettingsSaveResult> =>
    ipcRenderer.invoke("settings:save", partial),
  onOpenSettings: subscribeVoid("open-settings"),
  onThemeChanged: subscribe<AppSettings["theme"]>("theme:changed"),
  getScheduledCommands: (): Promise<ScheduledCommandsResult> =>
    ipcRenderer.invoke("scheduler:list"),
  saveScheduledCommands: (commands: ScheduledCommand[]): Promise<SchedulerSaveResult> =>
    ipcRenderer.invoke("scheduler:save", commands),
  runScheduledCommand: (commandId: string): Promise<SchedulerRunResult> =>
    ipcRenderer.invoke("scheduler:run", commandId),
  stopScheduledCommand: (commandId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("scheduler:stop", commandId),
  getRunOutput: (runId: string): Promise<RunLine[]> =>
    ipcRenderer.invoke("scheduler:output", runId),
  previewCron: (expr: string): Promise<CronPreview> =>
    ipcRenderer.invoke("scheduler:preview", expr),
  exportScheduledCommands: (): Promise<SchedulerExportResult> =>
    ipcRenderer.invoke("scheduler:export"),
  importScheduledCommands: (): Promise<SchedulerImportResult> =>
    ipcRenderer.invoke("scheduler:import"),
  onSchedulerUpdate: subscribe<SchedulerSnapshot>("scheduler:update"),
  getJsScripts: (): Promise<JsScriptsResult> => ipcRenderer.invoke("scripts:list"),
  saveJsScripts: (scripts: JsScript[]): Promise<SchedulerSaveResult> =>
    ipcRenderer.invoke("scripts:save", scripts),
  runJsScript: (scriptId: string): Promise<SchedulerRunResult> =>
    ipcRenderer.invoke("scripts:run", scriptId),
  stopJsScript: (scriptId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("scripts:stop", scriptId),
  exportJsScripts: (): Promise<SchedulerExportResult> => ipcRenderer.invoke("scripts:export"),
  importJsScripts: (): Promise<JsScriptsImportResult> => ipcRenderer.invoke("scripts:import"),
};

export type AppAPI = typeof appAPI;

contextBridge.exposeInMainWorld("appAPI", appAPI);
