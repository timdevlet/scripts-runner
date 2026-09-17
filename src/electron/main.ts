// Electron main process: a tray app that runs the command scheduler in the background.
// Closing the window hides it to the tray (schedules keep firing); quit from the tray menu
// (or Settings → close-quits) to actually exit.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  Tray,
} from "electron";
import { errorText } from "../domain/errors.js";
import type { ThemePreference } from "../domain/theme.js";
import { enableTimestamps, type LogEntry, logError, onLog } from "../log.js";
import { installSchedulerIpc, type SchedulerBridge } from "./scheduler-ipc.js";
import { type AppSettings, getSettings, saveSettings } from "./settings.js";
import { installUpdateIpc, type UpdateBridge } from "./update-check.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Packaged apps live in a read-only asar archive, so settings and the command list must be
// written to a writable folder: next to the .exe for a portable build, otherwise the per-user
// data dir. paths.ts reads APP_DATA_DIR lazily, so setting it here — before any load — is enough.
if (app.isPackaged && !process.env.APP_DATA_DIR) {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR ?? app.getPath("userData");
  process.env.APP_DATA_DIR = dir;
}

const MAX_HISTORY = 2000;
const history: LogEntry[] = [];

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let schedulerBridge: SchedulerBridge | null = null;
// The GitHub-releases update check; applies the update itself only on installed Windows builds.
let updateBridge: UpdateBridge | null = null;
let quitting = false;

const DARK_BG = "#0d1117";
const LIGHT_BG = "#ffffff";
const SAND_BG = "#fefefe";
let currentTheme: ThemePreference = "dark";
let minimizeToTrayOnClose = true;

function windowBackground(): string {
  if (nativeTheme.shouldUseDarkColors) return DARK_BG;
  return currentTheme === "sand" ? SAND_BG : LIGHT_BG;
}

function applyTheme(theme: ThemePreference): void {
  currentTheme = theme;
  nativeTheme.themeSource = theme === "sand" ? "light" : theme;
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(windowBackground());
    win.webContents.send("theme:changed", theme);
  }
}

function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  app.setLoginItemSettings({ openAtLogin: enabled });
}

function pushHistory(entry: LogEntry): void {
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
}

// Windows draws the window and taskbar icon unmasked, so it gets the circular artwork on a
// transparent canvas; icon.png is the full-bleed square macOS and Linux expect.
function windowIconFile(): string {
  return process.platform === "win32" ? "icon-win.png" : "icon.png";
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 860,
    height: 580,
    minWidth: 700,
    minHeight: 500,
    title: "Command Scheduler",
    icon: nativeImage.createFromPath(path.join(__dirname, windowIconFile())),
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 16 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void w.loadURL(devServerUrl);
  } else {
    void w.loadFile(path.join(__dirname, "renderer", "index.html"));
  }

  w.on("close", (e) => {
    if (quitting) return;
    if (minimizeToTrayOnClose) {
      e.preventDefault();
      w.hide();
    } else {
      quitting = true;
      app.quit();
    }
  });

  w.webContents.on("context-menu", (_e, params) => {
    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        ]
      : params.selectionText.trim()
        ? [{ role: "copy" }]
        : [];
    if (template.length > 0) Menu.buildFromTemplate(template).popup();
  });

  return w;
}

function showWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function sendLog(entry: LogEntry): void {
  if (win && !win.isDestroyed()) win.webContents.send("log", entry);
}

function openSettings(): void {
  showWindow();
  if (!win) return;
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (win && !win.isDestroyed()) win.webContents.send("open-settings");
    });
  } else {
    win.webContents.send("open-settings");
  }
}

function buildTray(): void {
  const isMac = process.platform === "darwin";
  const trayImg = nativeImage.createFromPath(
    path.join(__dirname, isMac ? "tray.png" : "tray-white.png"),
  );
  if (isMac) {
    trayImg.setTemplateImage(true);
  } else {
    trayImg.addRepresentation({
      scaleFactor: 1.5,
      buffer: nativeImage.createFromPath(path.join(__dirname, "tray-white@1.5x.png")).toPNG(),
    });
  }
  tray = new Tray(trayImg);
  tray.setToolTip("Command Scheduler");
  tray.on("double-click", () => showWindow());
  tray.on("click", () => showWindow());
}

function refreshTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show window", click: () => showWindow() },
      { label: "Settings…", click: () => openSettings() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function applySettingsToRunningApp(): Promise<void> {
  const next = await getSettings();
  minimizeToTrayOnClose = next.minimizeToTrayOnClose;
  applyLaunchAtLogin(next.launchAtLogin);
  applyTheme(next.theme);
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null);
  enableTimestamps();
  onLog((entry) => {
    pushHistory(entry);
    sendLog(entry);
  });

  const settings = await getSettings();
  applyTheme(settings.theme);
  minimizeToTrayOnClose = settings.minimizeToTrayOnClose;
  applyLaunchAtLogin(settings.launchAtLogin);
  nativeTheme.on("updated", () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
  });
  buildTray();
  refreshTrayMenu();
  win = createWindow();

  ipcMain.handle("log:history", () => history);
  ipcMain.on("log:clear", () => {
    history.length = 0;
  });
  ipcMain.handle("app:version", () => app.getVersion());

  // Update check + download/install IPC (src/electron/update-check.ts).
  updateBridge = installUpdateIpc(() => win);
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:save", async (_e, partial: unknown) => {
    const raw = typeof partial === "object" && partial !== null ? partial : {};
    const before = await getSettings();
    const next = await saveSettings(raw as Partial<AppSettings>);
    await applySettingsToRunningApp();
    // The Scripts tab is reading a different folder now. Nothing else would notice, so the
    // scheduler is told to re-read and push the new list to the tab.
    if (next.scriptsDir !== before.scriptsDir) await schedulerBridge?.reloadScripts();
    return { ok: true as const };
  });

  try {
    schedulerBridge = await installSchedulerIpc(() => win);
  } catch (err) {
    logError(`Failed to start the scheduler: ${errorText(err)}`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(() =>
    start().catch((err) => {
      const message = errorText(err);
      console.error(`Startup failed: ${message}`);
      dialog.showErrorBox("Command Scheduler could not start", message);
      app.exit(1);
    }),
  );

  app.on("window-all-closed", () => {
    /* stay alive in the tray */
  });

  app.on("before-quit", () => {
    quitting = true;
    schedulerBridge?.dispose();
    updateBridge?.dispose();
    tray?.destroy();
  });
}
