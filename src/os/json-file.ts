// Shared plumbing for the app's JSON file stores (the config, the feature flags, the scheduled
// commands): an ENOENT-tolerant read, an atomic write, and a writer that serializes overlapping
// read-modify-writes. Each store keeps only its path resolution and its normalization rules.

import { chmod, readFile, rename, writeFile } from "node:fs/promises";

// Serialize async operations behind a single promise chain, so overlapping read-modify-writes of
// the same file can't drop each other's changes. Returns a `run(op)` that queues `op` after every
// previously queued operation.
export function createSerializedWriter(): <T>(op: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return (op) => {
    const run = chain.then(op);
    // Keep the chain usable after a failure; the failure still rejects `run` for its caller.
    chain = run.catch(() => undefined);
    return run;
  };
}

// Read and parse a JSON file. A missing file returns `undefined` (the normal first-run state);
// any other error — unreadable file, malformed JSON — propagates to the caller.
export async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(raw) as unknown;
}

// Write-then-rename so a crash mid-write can't truncate the file. `mode` is applied to the temp
// file before the rename, so a file that should be private (the secret vault) is never readable by
// anyone else, not even for the moment between the write and the rename.
export async function writeTextFileAtomic(
  path: string,
  text: string,
  mode?: number,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  // Explicitly, because writeFile's mode only applies when it creates the file: a temp file left
  // behind by an interrupted write would otherwise keep whatever mode it already had.
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, path);
}

// Pretty-printed JSON with a trailing newline (the format all the stores share), atomically.
export async function writeJsonFile(path: string, value: unknown, mode?: number): Promise<void> {
  await writeTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}
