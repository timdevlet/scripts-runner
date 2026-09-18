// Reads and writes secrets.json — the vault behind {{NAME}} in a command or a script field, kept in a
// script. Its own file, next to settings.json in the data dir (see src/paths.ts), so the files
// that describe jobs hold names only and stay safe to commit, export and hand to someone else.
//
// Written 0600: on a shared machine the other accounts can't read it. That is the whole of the
// protection — this is a config file, not an encrypted store, and anything running as you can
// still read it, the same as a ~/.netrc or an .env.

import { join } from "node:path";
import { parseSecretsFile, serializeSecretsFile } from "./domain/secrets.js";
import { createSerializedWriter, readJsonFile, writeTextFileAtomic } from "./os/json-file.js";
import { dataDir } from "./paths.js";

// Owner read/write only.
const SECRETS_MODE = 0o600;

export function secretsPath(): string {
  return process.env.SECRETS_PATH?.trim() || join(dataDir(), "secrets.json");
}

// A missing file is the normal first-run state and reads as an empty vault. Malformed JSON throws,
// like every other store here: a bad file must not be silently replaced by the next save, which
// would drop every key in it.
export async function loadSecrets(): Promise<Record<string, string>> {
  const raw = await readJsonFile(secretsPath());
  if (raw === undefined) return {};
  return parseSecretsFile(raw);
}

const serialized = createSerializedWriter();

export function saveSecrets(secrets: Record<string, string>): Promise<void> {
  return serialized(() =>
    writeTextFileAtomic(secretsPath(), serializeSecretsFile(secrets), SECRETS_MODE),
  );
}
