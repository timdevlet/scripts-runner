import { describe, expect, it } from "vitest";
import {
  isNewerVersion,
  pickUpdateFromRelease,
  pickUpdateFromReleases,
} from "../src/domain/update.js";

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
    // A version has to be a version. The rolling prerelease is tagged "latest", so its version
    // comes from its asset names instead — never from the tag.
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

  it("reads the rolling prerelease's version off its asset names", () => {
    // The "latest" tag says nothing about what's inside, but electron-builder stamps the version
    // into every asset. Without this the app sits on "up to date" while a newer build is right
    // there — the repo publishes no versioned releases at all today.
    expect(pickUpdateFromRelease(release({ tag_name: "latest" }), "0.1.2", "win32", "x64")).toEqual(
      {
        version: "0.2.0",
        tag: "latest",
        url: `${DOWNLOAD}/setup.exe`,
      },
    );
  });

  it("reads the version from assets that don't fit this platform", () => {
    // A Linux client sees no .appimage in these releases; it should still learn the version and
    // be handed the release page rather than give up.
    expect(pickUpdateFromRelease(release({ tag_name: "latest" }), "0.1.2", "linux", "x64")).toEqual(
      {
        version: "0.2.0",
        tag: "latest",
        url: "https://github.com/timdevlet/scripts-runner/releases/tag/0.2.0",
      },
    );
  });

  it("takes the highest version when assets disagree", () => {
    // A leftover asset from an older build must not drag the release backwards.
    const mixed = release({
      tag_name: "latest",
      assets: [
        {
          name: "command-scheduler-Setup-0.1.1-x64.exe",
          browser_download_url: `${DOWNLOAD}/old-setup.exe`,
        },
        {
          name: "command-scheduler-Setup-0.2.0-x64.exe",
          browser_download_url: `${DOWNLOAD}/setup.exe`,
        },
      ],
    });
    expect(pickUpdateFromRelease(mixed, "0.1.2", "win32", "x64")?.version).toBe("0.2.0");
  });

  it("returns null for an unversioned tag whose assets carry no version either", () => {
    const nameless = release({
      tag_name: "latest",
      assets: [{ name: "latest.yml", browser_download_url: `${DOWNLOAD}/latest.yml` }],
    });
    expect(pickUpdateFromRelease(nameless, "0.1.2", "win32", "x64")).toBeNull();
  });

  it("does not offer the rolling prerelease when it is not newer", () => {
    expect(pickUpdateFromRelease(release({ tag_name: "latest" }), "0.2.0", "win32", "x64")).toBe(
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

// The /releases list is what the app actually calls now. Its shape is the same objects, plus the
// rolling "latest" prerelease CI republishes on every push to main — the release that made
// /releases/latest answer 404 and wedged the update check.
describe("pickUpdateFromReleases", () => {
  const rolling = release({
    tag_name: "latest",
    prerelease: true,
    html_url: "https://github.com/timdevlet/scripts-runner/releases/tag/latest",
  });

  it("finds the versioned release past the rolling 'latest' prerelease", () => {
    const found = pickUpdateFromReleases([rolling, release()], "0.1.4", "win32");
    expect(found).toEqual({
      version: "0.2.0",
      tag: "0.2.0",
      url: `${DOWNLOAD}/setup.exe`,
    });
  });

  it("offers the rolling prerelease when it is the only release", () => {
    // The repo's actual state: one "latest" prerelease holding the newest build, no versioned
    // releases. Answering "up to date" here is the bug that hid every build after 0.1.2.
    expect(pickUpdateFromReleases([rolling], "0.1.4", "win32")).toEqual({
      version: "0.2.0",
      tag: "latest",
      url: `${DOWNLOAD}/setup.exe`,
    });
  });

  it("prefers the tagged release over the rolling one at the same version", () => {
    // Both are cut from the same commit, but "latest" is deleted and recreated on every push to
    // main — its download URLs are the ones that rot.
    expect(pickUpdateFromReleases([rolling, release()], "0.1.4", "win32")?.tag).toBe("0.2.0");
    expect(pickUpdateFromReleases([release(), rolling], "0.1.4", "win32")?.tag).toBe("0.2.0");
  });

  it("picks the highest version, not GitHub's newest-first position", () => {
    const older = release({ tag_name: "0.3.0" });
    const newer = release({ tag_name: "0.10.0" });
    // Newest-created first, as GitHub returns them: a 0.3.0 patch cut after 0.10.0 leads.
    expect(pickUpdateFromReleases([older, newer], "0.1.4", "win32")?.version).toBe("0.10.0");
  });

  it("skips drafts, whose assets aren't publicly downloadable", () => {
    const draft = release({ tag_name: "0.9.0", draft: true });
    expect(pickUpdateFromReleases([draft, release()], "0.1.4", "win32")?.version).toBe("0.2.0");
  });

  it("returns null for an empty list or a non-array body", () => {
    expect(pickUpdateFromReleases([], "0.1.4", "win32")).toBeNull();
    expect(pickUpdateFromReleases({ message: "Not Found" }, "0.1.4", "win32")).toBeNull();
    expect(pickUpdateFromReleases(null, "0.1.4", "win32")).toBeNull();
  });

  it("ignores releases that are not newer than the running version", () => {
    expect(pickUpdateFromReleases([release()], "0.2.0", "win32")).toBeNull();
    expect(pickUpdateFromReleases([release()], "1.0.0", "win32")).toBeNull();
  });
});
