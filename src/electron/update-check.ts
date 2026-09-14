// Auto-update against GitHub releases. Detection is ours (the GitHub API + src/domain/update.ts,
// which knows to skip the rolling "latest" prerelease); applying the update depends on how the
// app was installed:
//
//  - Windows, installed from the NSIS setup ("install" mode): electron-updater downloads the new
//    installer (verified against the release's latest.yml sha512) and quitAndInstall() restarts
//    into the new version. The feed is a *generic* provider pointed at the found release's
//    download directory — not electron-updater's GitHub provider, whose tag parsing chokes on
//    the rolling "latest" tag.
//  - Everywhere else ("browser" mode): the download opens in the browser. A portable .exe can't
//    replace itself while it's running, macOS auto-install needs a signed app (Squirrel.Mac
//    validates the signature) and these builds are unsigned, and dev builds aren't packaged.

import { app, ipcMain, shell } from "electron";
// Named import (not default + destructure): electron-updater is CJS, and esbuild's CJS bundle
// leaves the default-import interop shim without a .default to read — the named form compiles to
// a plain property access that works.
import { autoUpdater } from "electron-updater";
import { errorText } from "../domain/errors.js";
import { pickUpdateFromRelease, type UpdateInfo, type UpdateState } from "../domain/update.js";
import { log, logError } from "../log.js";

const REPO = "timdevlet/scripts-runner";
const RELEASES_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// A tray app runs for weeks — re-check periodically so the button eventually appears without a
// restart. The renderer's mount-time pull within CACHE_TTL_MS of a check reuses the cached answer.
const STARTUP_DELAY_MS = 5_000;
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;

export type UpdateCheckResult =
  | { ok: true; update: UpdateState | null }
  | { ok: false; error: string };
export type UpdateActionResult = { ok: true } | { ok: false; error: string };

export interface UpdateBridge {
  // Stop the periodic re-checks and drop the IPC handlers (app quit).
  dispose(): void;
}

// Whether this build can install an update over itself. electron-updater can only apply the NSIS
// installer, so a packaged Windows build qualifies — unless it's the portable .exe, which runs
// from wherever the user dropped it and can't overwrite itself. electron-builder sets
// PORTABLE_EXECUTABLE_DIR only in that build, which is exactly the signal we need.
function canInstallUpdates(): boolean {
  return app.isPackaged && process.platform === "win32" && !process.env.PORTABLE_EXECUTABLE_DIR;
}

export function installUpdateIpc(getWindow: () => Electron.BrowserWindow | null): UpdateBridge {
  const canInstall = canInstallUpdates();

  // The last successful check's answer. update:download acts only on this — the renderer never
  // passes a URL over IPC, so a compromised renderer can't shell.openExternal (or feed the
  // updater) anything it likes.
  let found: UpdateInfo | null = null;
  let state: UpdateState | null = null;
  let lastChecked = 0;
  let inflight: Promise<UpdateCheckResult> | null = null;

  const setState = (next: UpdateState): void => {
    state = next;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("update:state", state);
  };

  async function fetchLatest(): Promise<UpdateCheckResult> {
    // GitHub rejects requests without a User-Agent. /releases/latest already excludes
    // prereleases, so the rolling "latest" (main) prerelease never shows up here.
    const res = await fetch(RELEASES_LATEST_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "scripts-runner" },
      // Without a timeout a hung connection pins `inflight` forever and every later check
      // returns the same never-settling promise — the update UI wedges for the session.
      signal: AbortSignal.timeout(15_000),
    });
    // 404 = no (non-prerelease) release published yet; that's "no update", not an error.
    if (res.status === 404) {
      found = null;
    } else if (!res.ok) {
      return { ok: false, error: `GitHub answered ${res.status} ${res.statusText}` };
    } else {
      found = pickUpdateFromRelease(await res.json(), app.getVersion(), process.platform);
    }
    lastChecked = Date.now();
    // Never regress a download in flight (or done) because a periodic re-check came back with
    // the same release; a *different* release resets the flow.
    if (found && found.version !== state?.version) {
      log(`Update available: version ${found.version} — ${found.url}`);
      setState({
        version: found.version,
        mode: canInstall ? "install" : "browser",
        phase: "available",
        percent: 0,
      });
    } else if (!found && state) {
      state = null;
    }
    return { ok: true, update: state };
  }

  // One check at a time, and a fresh-enough answer is reused — the renderer's mount-time pull,
  // the startup check, and the periodic tick all funnel through here.
  function check(): Promise<UpdateCheckResult> {
    if (inflight) return inflight;
    if (Date.now() - lastChecked < CACHE_TTL_MS)
      return Promise.resolve({ ok: true, update: state });
    const run: Promise<UpdateCheckResult> = fetchLatest()
      .catch((err): UpdateCheckResult => ({ ok: false, error: errorText(err) }))
      .then((result) => {
        if (inflight === run) inflight = null;
        return result;
      });
    inflight = run;
    return run;
  }

  // We drive downloads explicitly (and install on the user's click, with quit-time install as
  // the fallback if they never do).
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  const onProgress = (progress: { percent: number }): void => {
    if (state?.phase === "downloading")
      setState({ ...state, percent: Math.round(progress.percent) });
  };
  autoUpdater.on("download-progress", onProgress);

  ipcMain.handle("update:check", () => check());

  // Download the update (install mode), or hand it to the browser. In install mode this resolves
  // when the download has finished (or failed) — progress reaches the renderer via update:state
  // pushes in the meantime.
  ipcMain.handle("update:download", async (): Promise<UpdateActionResult> => {
    if (!found || !state) return { ok: false, error: "No update available." };
    if (state.mode === "browser") {
      try {
        await shell.openExternal(found.url);
        return { ok: true };
      } catch (err) {
        const message = `Could not open the download: ${errorText(err)}`;
        logError(message);
        return { ok: false, error: message };
      }
    }
    if (state.phase !== "available") return { ok: true }; // already downloading/downloaded
    setState({ ...state, phase: "downloading", percent: 0 });
    try {
      // Point electron-updater at the found release's own download directory and let it verify
      // + fetch the installer named by that release's latest.yml.
      autoUpdater.setFeedURL({
        provider: "generic",
        url: `https://github.com/${REPO}/releases/download/${encodeURIComponent(found.tag)}`,
      });
      const checked = await autoUpdater.checkForUpdates();
      if (!checked?.isUpdateAvailable) {
        throw new Error(`Release ${found.tag} has no update metadata (latest.yml) for this app.`);
      }
      await autoUpdater.downloadUpdate();
      setState({ ...state, phase: "downloaded", percent: 100 });
      log(`Update ${found.version} downloaded — restart the app to install it.`);
      return { ok: true };
    } catch (err) {
      setState({ ...state, phase: "available", percent: 0 });
      const message = `Update download failed: ${errorText(err)}`;
      logError(message);
      return { ok: false, error: message };
    }
  });

  // Quit and run the downloaded installer silently, relaunching into the new version.
  ipcMain.handle("update:install", (): UpdateActionResult => {
    if (state?.phase !== "downloaded") return { ok: false, error: "No downloaded update." };
    log(`Restarting to install update ${state.version}…`);
    // After the invoke's reply has gone out — quitAndInstall tears the app down immediately.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  });

  // Delayed a little so startup (the scheduler, first paint) isn't competing with a network call.
  const startupTimer = setTimeout(() => void check(), STARTUP_DELAY_MS);
  const recheckTimer = setInterval(() => void check(), RECHECK_INTERVAL_MS);

  return {
    dispose() {
      clearTimeout(startupTimer);
      clearInterval(recheckTimer);
      autoUpdater.off("download-progress", onProgress);
      ipcMain.removeHandler("update:check");
      ipcMain.removeHandler("update:download");
      ipcMain.removeHandler("update:install");
    },
  };
}
