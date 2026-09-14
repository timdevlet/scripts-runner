// The renderer's single seam to the preload bridge: every IPC call the UI or a store makes goes
// through `api`, so `window.appAPI` is touched nowhere else in the renderer. Each method resolves
// the bridge lazily, per call — the store modules are imported by the node-environment unit
// tests, where neither `window` nor the bridge exists.

import type { AppAPI } from "../../../preload.js";

export type {
  AppAPI,
  CronPreview,
  JsScriptsImportResult,
  JsScriptsResult,
  ScheduledCommandsResult,
  SchedulerExportResult,
  SchedulerImportResult,
  SchedulerRunResult,
  SchedulerSaveResult,
  SettingsSaveResult,
} from "../../../preload.js";

export const api: AppAPI = {
  onLog: (cb) => window.appAPI.onLog(cb),
  getHistory: () => window.appAPI.getHistory(),
  clearHistory: () => window.appAPI.clearHistory(),
  getAppVersion: () => window.appAPI.getAppVersion(),
  checkForUpdate: () => window.appAPI.checkForUpdate(),
  downloadUpdate: () => window.appAPI.downloadUpdate(),
  installUpdate: () => window.appAPI.installUpdate(),
  onUpdateState: (cb) => window.appAPI.onUpdateState(cb),
  getSettings: () => window.appAPI.getSettings(),
  saveSettings: (partial) => window.appAPI.saveSettings(partial),
  onOpenSettings: (cb) => window.appAPI.onOpenSettings(cb),
  onThemeChanged: (cb) => window.appAPI.onThemeChanged(cb),
  getScheduledCommands: () => window.appAPI.getScheduledCommands(),
  saveScheduledCommands: (commands) => window.appAPI.saveScheduledCommands(commands),
  runScheduledCommand: (commandId) => window.appAPI.runScheduledCommand(commandId),
  stopScheduledCommand: (commandId) => window.appAPI.stopScheduledCommand(commandId),
  getRunOutput: (runId) => window.appAPI.getRunOutput(runId),
  previewCron: (expr) => window.appAPI.previewCron(expr),
  exportScheduledCommands: () => window.appAPI.exportScheduledCommands(),
  importScheduledCommands: () => window.appAPI.importScheduledCommands(),
  onSchedulerUpdate: (cb) => window.appAPI.onSchedulerUpdate(cb),
  getJsScripts: () => window.appAPI.getJsScripts(),
  saveJsScripts: (scripts) => window.appAPI.saveJsScripts(scripts),
  runJsScript: (scriptId) => window.appAPI.runJsScript(scriptId),
  stopJsScript: (scriptId) => window.appAPI.stopJsScript(scriptId),
  exportJsScripts: () => window.appAPI.exportJsScripts(),
  importJsScripts: () => window.appAPI.importJsScripts(),
};
