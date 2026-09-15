// Pure logic for the update check: decide whether a GitHub release is a newer version than the
// running app, and which of its assets fits this platform. The network/IPC half lives in
// src/electron/update-check.ts; keeping this half pure lets the unit tests cover the decisions.

// A newer release: the version, the tag it lives under (verbatim, "v" prefix and all — it names
// the release's download directory), and where the download lives — the platform asset when the
// release has one, else the release page.
export type UpdateInfo = {
  version: string;
  tag: string;
  url: string;
};

// How the running platform can apply an update. "install": the app downloads and installs it
// itself (electron-updater — packaged Windows builds, where unsigned auto-update works, and only
// from the NSIS installer; a portable .exe can't replace itself). "browser": the download just
// opens in the browser (macOS/Linux — auto-install needs a signed app there — and dev builds).
type UpdateMode = "install" | "browser";

type UpdatePhase = "available" | "downloading" | "downloaded";

// What the renderer renders: one button whose label/action follows the phase. In "browser" mode
// the phase never leaves "available".
export type UpdateState = {
  version: string;
  mode: UpdateMode;
  phase: UpdatePhase;
  // Download progress, 0–100, meaningful while phase is "downloading".
  percent: number;
};

// "1.2.3" / "v1.2.3" → [1, 2, 3]; anything else (including the rolling "latest" prerelease tag)
// is null and never counts as an update.
function parseVersion(raw: string): [number, number, number] | null {
  const m = raw
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Which asset filename belongs to which platform, matching the electron-builder targets in
// package.json: NSIS + portable .exe on Windows, a zipped .app on macOS. The .blockmap sidecars
// end in ".exe.blockmap"/".zip.blockmap", so an exact suffix test skips them for free.
const ASSET_EXTENSION: Partial<Record<string, string>> = {
  win32: ".exe",
  darwin: ".zip",
  linux: ".appimage",
};

// macOS ships one zip per architecture — "…-arm64-mac.zip" for Apple Silicon and plain
// "…-mac.zip" for Intel. Handing an Intel Mac the arm64 build (or the reverse) is worse than
// offering nothing, so the arch has to be part of the match.
function matchesArch(name: string, platform: string, arch: string): boolean {
  if (platform !== "darwin") return true;
  return arch === "arm64" ? name.includes("arm64") : !name.includes("arm64");
}

// Decide whether `release` (an untrusted GitHub /releases/latest response body) offers an update
// over `currentVersion`, and return what to download. Null when the tag isn't a newer semver
// version or there's nothing to link to. Windows releases carry both the NSIS installer
// ("… Setup.exe") and the portable .exe — prefer the installer, since it's the only one
// electron-updater can actually apply.
export function pickUpdateFromRelease(
  release: unknown,
  currentVersion: string,
  platform: string,
  arch: string = process.arch,
): UpdateInfo | null {
  const rel = (typeof release === "object" && release !== null ? release : {}) as {
    tag_name?: unknown;
    html_url?: unknown;
    assets?: unknown;
  };
  const tag = typeof rel.tag_name === "string" ? rel.tag_name.trim() : "";
  if (!isNewerVersion(tag, currentVersion)) return null;
  const version = tag.replace(/^v/i, "");

  const extension = ASSET_EXTENSION[platform];
  const assets = (Array.isArray(rel.assets) ? rel.assets : [])
    .map((a: unknown) => {
      const asset = (typeof a === "object" && a !== null ? a : {}) as {
        name?: unknown;
        browser_download_url?: unknown;
      };
      return {
        name: typeof asset.name === "string" ? asset.name : "",
        url: typeof asset.browser_download_url === "string" ? asset.browser_download_url : "",
      };
    })
    .filter(
      (a) =>
        a.url &&
        extension &&
        a.name.toLowerCase().endsWith(extension) &&
        matchesArch(a.name.toLowerCase(), platform, arch),
    );
  const installer = assets.find((a) => a.name.toLowerCase().includes("setup")) ?? assets[0];

  // No asset for this platform/arch still beats a dead end: fall back to the release page.
  const url = installer?.url || (typeof rel.html_url === "string" ? rel.html_url : "");
  return url ? { version, tag, url } : null;
}

// Pick the newest update out of a GitHub /releases *list* response.
//
// Why the list and not /releases/latest: that endpoint 404s until a non-prerelease release
// exists, and this project's CI publishes a rolling "latest" prerelease on every push to main.
// A repo can therefore sit at "404 forever" while releases plainly exist — which is exactly the
// state the in-app check was stuck in. The list endpoint answers [] instead of 404, and it
// includes prereleases, so the rolling "latest" is skipped here on the merits (its tag isn't a
// semver version) rather than by the endpoint's own definition.
//
// Drafts are skipped: their assets aren't publicly downloadable, so offering one is a dead link.
export function pickUpdateFromReleases(
  releases: unknown,
  currentVersion: string,
  platform: string,
  arch: string = process.arch,
): UpdateInfo | null {
  if (!Array.isArray(releases)) return null;
  let best: UpdateInfo | null = null;
  for (const entry of releases) {
    const rel = (typeof entry === "object" && entry !== null ? entry : {}) as { draft?: unknown };
    if (rel.draft === true) continue;
    const found = pickUpdateFromRelease(entry, currentVersion, platform, arch);
    // GitHub returns newest-first, but that's creation order, not version order — a patch on an
    // old branch would win. Compare versions instead of trusting the position.
    if (found && (!best || isNewerVersion(found.version, best.version))) best = found;
  }
  return best;
}
