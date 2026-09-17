import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecrets, saveSecrets, secretsPath } from "../src/secrets-store.js";

// The real filesystem: what matters about this store is the file it leaves behind — who can read
// it, and that a file it couldn't parse is never written over.

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "secrets-store-"));
  process.env.SECRETS_PATH = join(dir, "secrets.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SECRETS_PATH;
});

describe("loadSecrets", () => {
  it("reads a missing file as an empty vault — the normal first run", async () => {
    expect(await loadSecrets()).toEqual({});
  });

  // Loudly, so the Settings tab reports it and refuses to save: a save would replace the file with
  // whatever the app has in memory, which is every key in it gone.
  it("throws on a malformed file rather than reporting an empty vault", async () => {
    writeFileSync(secretsPath(), "{ not json", "utf8");
    await expect(loadSecrets()).rejects.toThrow();
  });
});

describe("saveSecrets", () => {
  it("round-trips through the file", async () => {
    await saveSecrets({ DB_API_KEY: "s3cret" });
    expect(await loadSecrets()).toEqual({ DB_API_KEY: "s3cret" });
  });

  it("writes a versioned envelope", async () => {
    await saveSecrets({ DB_API_KEY: "s3cret" });
    expect(JSON.parse(readFileSync(secretsPath(), "utf8"))).toEqual({
      version: 1,
      secrets: { DB_API_KEY: "s3cret" },
    });
  });

  // The one protection this file has: on a shared machine, the other accounts can't read it.
  it.skipIf(process.platform === "win32")("writes it readable only by its owner", async () => {
    await saveSecrets({ DB_API_KEY: "s3cret" });
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")(
    "re-tightens the mode when an earlier write left a readable temp file behind",
    async () => {
      writeFileSync(`${secretsPath()}.tmp`, "stale", { mode: 0o644 });
      await saveSecrets({ DB_API_KEY: "s3cret" });
      expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
    },
  );

  it("drops a removed secret rather than merging with what's on disk", async () => {
    await saveSecrets({ A: "1", B: "2" });
    await saveSecrets({ A: "1" });
    expect(await loadSecrets()).toEqual({ A: "1" });
  });
});
