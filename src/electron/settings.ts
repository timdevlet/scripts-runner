// User preferences: theme, close-to-tray, launch-at-login. Stored as settings.json in the data
// dir (see src/paths.ts). Whole-file replace, serialized so overlapping autosaves can't drop
// each other.

import { join } from "node:path";
import { normalizeTheme, type ThemePreference } from "../domain/theme.js";
import { createSerializedWriter, readJsonFile, writeJsonFile } from "../os/json-file.js";
import { dataDir } from "../paths.js";

export interface AppSettings {
  // When true, closing the window hides to the tray; when false, it quits the app.
  minimizeToTrayOnClose: boolean;
  // When true, the app is registered as an OS login item (Windows/macOS) and starts at sign-in.
  launchAtLogin: boolean;
  // App color theme: "light", "dark", "sand", or "system" (follow the OS setting).
  theme: ThemePreference;
}

function settingsPath(): string {
  return process.env.APP_SETTINGS_PATH?.trim() || join(dataDir(), "settings.json");
}

function defaults(): AppSettings {
  return {
    minimizeToTrayOnClose: true,
    launchAtLogin: false,
    theme: "dark",
  };
}

function normalize(raw: unknown): AppSettings {
  const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const base = defaults();
  return {
    minimizeToTrayOnClose:
      typeof entry.minimizeToTrayOnClose === "boolean"
        ? entry.minimizeToTrayOnClose
        : base.minimizeToTrayOnClose,
    launchAtLogin:
      typeof entry.launchAtLogin === "boolean" ? entry.launchAtLogin : base.launchAtLogin,
    theme: normalizeTheme(entry.theme),
  };
}

const serialized = createSerializedWriter();

export async function getSettings(): Promise<AppSettings> {
  const raw = await readJsonFile(settingsPath());
  if (raw === undefined) return defaults();
  return normalize(raw);
}

export function saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  return serialized(async () => {
    const next = await getSettings();
    if (typeof partial.minimizeToTrayOnClose === "boolean") {
      next.minimizeToTrayOnClose = partial.minimizeToTrayOnClose;
    }
    if (typeof partial.launchAtLogin === "boolean") {
      next.launchAtLogin = partial.launchAtLogin;
    }
    if (partial.theme !== undefined) next.theme = normalizeTheme(partial.theme);
    await writeJsonFile(settingsPath(), next);
    return next;
  });
}
