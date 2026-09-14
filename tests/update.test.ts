import { describe, expect, it } from "vitest";
import { isNewerVersion, pickUpdateFromRelease } from "../src/domain/update.js";

// Asset names as electron-builder actually produces them for this app: an NSIS installer, a
// portable .exe, and one zipped .app per macOS architecture. Deliberately space-free — spaces
// get hyphenated in latest.yml but dotted by GitHub on upload, and the updater 404s on the
// difference (see build.artifactName in package.json).
const DOWNLOAD = "https://github.com/timdevlet/scripts-runner/releases/download/0.2.0";
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: "0.2.0",
  html_url: "https://github.com/timdevlet/scripts-runner/releases/tag/0.2.0",
  assets: [
    {
      name: "command-scheduler-Setup-0.2.0-x64.exe",
      browser_download_url: `${DOWNLOAD}/setup.exe`,
    },
    {
      name: "command-scheduler-Setup-0.2.0-x64.exe.blockmap",
      browser_download_url: `${DOWNLOAD}/setup.exe.blockmap`,
    },
    { name: "command-scheduler-0.2.0-x64.exe", browser_download_url: `${DOWNLOAD}/portable.exe` },
    {
      name: "command-scheduler-0.2.0-arm64.zip",
      browser_download_url: `${DOWNLOAD}/arm64.zip`,
    },
    { name: "command-scheduler-0.2.0-x64.zip", browser_download_url: `${DOWNLOAD}/x64.zip` },
    { name: "latest.yml", browser_download_url: `${DOWNLOAD}/latest.yml` },
  ],
  ...over,
});

describe("isNewerVersion", () => {
  it("compares each part numerically, not as text", () => {
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.1.2", "0.1.10")).toBe(false);
  });

  it("accepts a leading v on either side", () => {
    expect(isNewerVersion("v0.2.0", "0.1.2")).toBe(true);
    expect(isNewerVersion("0.2.0", "v0.1.2")).toBe(true);
  });

  it("is false for the same version", () => {
    expect(isNewerVersion("0.1.2", "0.1.2")).toBe(false);
  });

  it("never treats an unparseable tag as newer", () => {
    // The rolling prerelease from main is tagged "latest" — it must not offer itself as an update.
    expect(isNewerVersion("latest", "0.1.2")).toBe(false);
    expect(isNewerVersion("0.2", "0.1.2")).toBe(false);
    expect(isNewerVersion("", "0.1.2")).toBe(false);
  });
});

describe("pickUpdateFromRelease", () => {
  it("prefers the NSIS installer over the portable .exe on Windows", () => {
    // Only the installer is applicable by electron-updater; the portable exe can't self-replace.
    expect(pickUpdateFromRelease(release(), "0.1.2", "win32", "x64")).toEqual({
      version: "0.2.0",
      tag: "0.2.0",
      url: `${DOWNLOAD}/setup.exe`,
    });
  });

  it("picks the matching macOS architecture", () => {
    expect(pickUpdateFromRelease(release(), "0.1.2", "darwin", "arm64")?.url).toBe(
      `${DOWNLOAD}/arm64.zip`,
    );
    expect(pickUpdateFromRelease(release(), "0.1.2", "darwin", "x64")?.url).toBe(
      `${DOWNLOAD}/x64.zip`,
    );
  });

  it("skips the .blockmap sidecars", () => {
    const onlyBlockmap = release({
      assets: [
        {
          name: "command-scheduler-Setup-0.2.0-x64.exe.blockmap",
          browser_download_url: `${DOWNLOAD}/setup.exe.blockmap`,
        },
      ],
    });
    // Nothing installable left, so it falls back to the release page rather than the sidecar.
    expect(pickUpdateFromRelease(onlyBlockmap, "0.1.2", "win32", "x64")?.url).toBe(
      "https://github.com/timdevlet/scripts-runner/releases/tag/0.2.0",
    );
  });

  it("still understands the older dotted asset names", () => {
    // Releases published before build.artifactName was pinned carry GitHub's dotted spellings.
    const legacy = release({
      assets: [
        {
          name: "Command.Scheduler.Setup.0.2.0.exe",
          browser_download_url: `${DOWNLOAD}/legacy-setup.exe`,
        },
        {
          name: "Command.Scheduler-0.2.0-arm64-mac.zip",
          browser_download_url: `${DOWNLOAD}/legacy-arm64.zip`,
        },
      ],
    });
    expect(pickUpdateFromRelease(legacy, "0.1.2", "win32", "x64")?.url).toBe(
      `${DOWNLOAD}/legacy-setup.exe`,
    );
    expect(pickUpdateFromRelease(legacy, "0.1.2", "darwin", "arm64")?.url).toBe(
      `${DOWNLOAD}/legacy-arm64.zip`,
    );
  });

  it("returns null when the release is not newer", () => {
    expect(pickUpdateFromRelease(release(), "0.2.0", "win32", "x64")).toBeNull();
    expect(pickUpdateFromRelease(release(), "9.0.0", "win32", "x64")).toBeNull();
  });

  it("returns null for the rolling latest prerelease", () => {
    expect(pickUpdateFromRelease(release({ tag_name: "latest" }), "0.1.2", "win32", "x64")).toBe(
      null,
    );
  });

  it("keeps the tag verbatim so the download directory resolves", () => {
    // electron-updater's feed URL is built from the tag, so a "v" prefix must survive.
    const tagged = release({ tag_name: "v0.2.0" });
    expect(pickUpdateFromRelease(tagged, "0.1.2", "win32", "x64")).toMatchObject({
      version: "0.2.0",
      tag: "v0.2.0",
    });
  });

  it("falls back to the release page when no asset fits the platform", () => {
    expect(pickUpdateFromRelease(release(), "0.1.2", "linux", "x64")?.url).toBe(
      "https://github.com/timdevlet/scripts-runner/releases/tag/0.2.0",
    );
  });

  it("survives a garbage response body", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { assets: "no" }]) {
      expect(pickUpdateFromRelease(bad, "0.1.2", "win32", "x64")).toBeNull();
    }
    // A newer tag with a malformed asset list still yields the release page.
    expect(
      pickUpdateFromRelease(
        { tag_name: "0.2.0", html_url: "u", assets: [null, 1] },
        "0.1.2",
        "win32",
        "x64",
      ),
    ).toEqual({ version: "0.2.0", tag: "0.2.0", url: "u" });
  });
});
