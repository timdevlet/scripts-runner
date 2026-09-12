// Where the app keeps its writable files (settings.json, scheduled-commands.json, js-scripts.json).
//
// Packaged builds live in a read-only asar, so main.ts redirects APP_DATA_DIR to userData (or the
// portable exe folder) before the first read. In unpackaged / CLI use the files sit next to the
// project root, matching how the original TV app kept its config.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DATA_DIR = join(__dirname, "..");

export function dataDir(): string {
  return process.env.APP_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
}
