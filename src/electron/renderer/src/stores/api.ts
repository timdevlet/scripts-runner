// The renderer's single seam to the preload bridge: every IPC call the UI or a store makes goes
// through `api`, so `window.appAPI` is touched nowhere else in the renderer. Each method resolves
// the bridge lazily, per call — the store modules are imported by the node-environment unit
// tests, where neither `window` nor the bridge exists.

import type { AppAPI } from "../../../preload.js";

export type {
  AppAPI,
  CronPreview,
  DirectoryPickResult,
  JsScriptEditSource,
  JsScriptEditState,
  JsScriptsImportResult,
  JsScriptsReloaded,
  JsScriptsResult,
  ScheduledCommandsResult,
  SchedulerExportResult,
  SchedulerImportResult,
  SchedulerRunResult,
  SchedulerSaveResult,
  SecretsResult,
  SettingsSaveResult,
} from "../../../preload.js";

export const api: AppAPI = {
  onLog: (cb) => window.appAPI.onLog(cb),
  getHistory: () => window.appAPI.getHistory(),
  clearHistory: () => window.appAPI.clearHistory(),
  getAppVersion: () => window.appAPI.getAppVersion(),
  checkForUpdate: (force) => window.appAPI.checkForUpdate(force),
  downloadUpdate: () => window.appAPI.downloadUpdate(),
  installUpdate: () => window.appAPI.installUpdate(),
  onUpdateState: (cb) => window.appAPI.onUpdateState(cb),
  getSettings: () => window.appAPI.getSettings(),
  saveSettings: (partial) => window.appAPI.saveSettings(partial),
  onOpenSettings: (cb) => window.appAPI.onOpenSettings(cb),
  getSecrets: () => window.appAPI.getSecrets(),
  setSecret: (name, value) => window.appAPI.setSecret(name, value),
  removeSecret: (name) => window.appAPI.removeSecret(name),
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
  getJsScriptsDir: () => window.appAPI.getJsScriptsDir(),
  onJsScriptsReloaded: (cb) => window.appAPI.onJsScriptsReloaded(cb),
  saveJsScripts: (scripts) => window.appAPI.saveJsScripts(scripts),
  runJsScript: (scriptId) => window.appAPI.runJsScript(scriptId),
  stopJsScript: (scriptId) => window.appAPI.stopJsScript(scriptId),
  exportJsScripts: () => window.appAPI.exportJsScripts(),
  importJsScripts: () => window.appAPI.importJsScripts(),
  editJsScript: (scriptId) => window.appAPI.editJsScript(scriptId),
  onJsScriptEditSource: (cb) => window.appAPI.onJsScriptEditSource(cb),
  onJsScriptEditState: (cb) => window.appAPI.onJsScriptEditState(cb),
  pickDirectory: (current) => window.appAPI.pickDirectory(current),
};
