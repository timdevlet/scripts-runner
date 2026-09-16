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

// "1.2.3" / "v1.2.3" → [1, 2, 3]; anything else — the rolling "latest" prerelease tag included —
// is null. A tag that doesn't name a version never decides an update on its own; see
// versionFromAssets for where the answer comes from instead.
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

// The version a release ships, read off its asset filenames — electron-builder stamps it into
// every one of them ("command-scheduler-Setup-0.1.9-x64.exe").
//
// This exists for the rolling "latest" prerelease that CI republishes on every push to main. Its
// tag is the word "latest", so the tag alone says nothing about what's inside: an app on 0.1.8
// would keep answering "up to date" while a 0.1.9 build sat in that release — which is exactly
// the state the repo was in, since it holds no versioned releases at all. The assets do carry
// the version, so read it from them rather than treating the release as unidentifiable.
//
// The highest version wins rather than the first match: one stray leftover asset from an older
// build shouldn't drag the release backwards. Null when no name carries a version.
function versionFromAssets(names: readonly string[]): string | null {
  let best: [number, number, number] | null = null;
  for (const name of names) {
    for (const match of name.matchAll(/(\d+)\.(\d+)\.(\d+)/g)) {
      const found: [number, number, number] = [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
      ];
      if (!best || isNewerVersion(found.join("."), best.join("."))) best = found;
    }
  }
  return best ? best.join(".") : null;
}

// Decide whether `release` (an untrusted GitHub releases response entry) offers an update over
// `currentVersion`, and return what to download. Null when the release isn't a newer version or
// there's nothing to link to. Windows releases carry both the NSIS installer ("… Setup.exe") and
// the portable .exe — prefer the installer, since it's the only one electron-updater can apply.
//
// The version comes from the tag when the tag names one, and from the asset filenames when it
// doesn't (the rolling "latest" prerelease). `tag` is always returned verbatim either way: it
// names the release's download directory, which is what the electron-updater feed is built from.
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

  const assets = (Array.isArray(rel.assets) ? rel.assets : []).map((a: unknown) => {
    const asset = (typeof a === "object" && a !== null ? a : {}) as {
      name?: unknown;
      browser_download_url?: unknown;
    };
    return {
      name: typeof asset.name === "string" ? asset.name : "",
      url: typeof asset.browser_download_url === "string" ? asset.browser_download_url : "",
    };
  });

  // Every asset name, not just the ones that fit this platform: a Linux client sees no .appimage
  // in these releases, and it should still learn the release's version rather than give up.
  const version = parseVersion(tag)
    ? tag.replace(/^v/i, "")
    : versionFromAssets(assets.map((a) => a.name));
  if (!version || !isNewerVersion(version, currentVersion)) return null;

  const extension = ASSET_EXTENSION[platform];
  const downloads = assets.filter(
    (a) =>
      a.url &&
      extension &&
      a.name.toLowerCase().endsWith(extension) &&
      matchesArch(a.name.toLowerCase(), platform, arch),
  );
  const installer = downloads.find((a) => a.name.toLowerCase().includes("setup")) ?? downloads[0];

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
// includes prereleases, so the rolling "latest" is a candidate here like any other release.
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
    if (!found) continue;
    // GitHub returns newest-first, but that's creation order, not version order — a patch on an
    // old branch would win. Compare versions instead of trusting the position.
    if (!best || isNewerVersion(found.version, best.version)) {
      best = found;
      continue;
    }
    // Same version from two releases: take the tagged one. That's the rolling "latest" and the
    // versioned release that was cut from the same commit — and "latest" is deleted and
    // recreated on every push to main, so its download URLs are the ones that rot.
    if (found.version === best.version && parseVersion(found.tag) && !parseVersion(best.tag)) {
      best = found;
    }
  }
  return best;
}
