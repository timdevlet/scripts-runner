// File adapter for JS scripts: one folder per script, under a scripts directory the user can
// point anywhere.
//
//   <scriptsDir>/<slug>/script.js     the source, byte for byte — a real .js file
//   <scriptsDir>/<slug>/script.json   name, params, schedule, cwd, timeout
//
// The default <scriptsDir> is js-scripts/ in the data dir; the user can point it anywhere.
//
// The folder is named after the script so the directory reads like a project; the id inside
// script.json is what identifies it, so renaming a script moves its folder without costing it its
// run history. The shape and its coercion rules live in src/domain/js-script.ts.
//
// Everything here takes the directory as an argument rather than resolving it: it comes from a
// user setting, which is async to read and can change while the app is running.

import { mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type JsScript,
  normalizeJsScripts,
  parseJsScriptConfig,
  parseJsScriptFile,
  scriptFolderNames,
  serializeJsScriptConfig,
} from "./domain/js-script.js";
import { createSerializedWriter, readJsonFile, writeTextFileAtomic } from "./os/json-file.js";
import { dataDir } from "./paths.js";

const SOURCE_FILE = "script.js";
const CONFIG_FILE = "script.json";

// A folder caught mid-rename. Only left behind if the app died between the two halves of a move;
// it still loads as a script, and the next save finishes moving it.
const MOVING_SUFFIX = ".moving-";

// Named after the file it replaces rather than "scripts": in unpackaged use the data dir is the
// project root, which already has a scripts/ folder of build tooling.
export function defaultScriptsDir(): string {
  return join(dataDir(), "js-scripts");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

// JS_SCRIPTS_DIR wins over the setting — the same escape hatch JS_SCRIPTS_PATH was for the old
// single file, so a test or a second instance can be pointed elsewhere without editing settings.
export function resolveScriptsDir(configured: string): string {
  const raw = process.env.JS_SCRIPTS_DIR?.trim() || configured.trim();
  return raw ? resolve(expandHome(raw)) : defaultScriptsDir();
}

// A missing scripts directory is the normal first-run state, not an error.
async function listFolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readConfig(dir: string, folder: string): Promise<unknown> {
  return readJsonFile(join(dir, folder, CONFIG_FILE));
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export async function loadJsScripts(dir: string): Promise<JsScript[]> {
  const entries: { folder: string; script: JsScript; order: number }[] = [];
  for (const folder of await listFolders(dir)) {
    // No config: not a script folder. Anything else — unreadable, malformed JSON — propagates, so
    // the tab goes read-only with the reason instead of quietly losing a script that the next
    // autosave would then delete from disk.
    const raw = await readConfig(dir, folder);
    if (raw === undefined) continue;
    let source = "";
    try {
      source = await readFile(join(dir, folder, SOURCE_FILE), "utf8");
    } catch (err) {
      // A config with no source beside it is an empty script, not a failure — that is what a
      // half-finished hand-written folder looks like, and the tab can still open it.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    entries.push({ folder, ...parseJsScriptConfig(raw, source, folder) });
  }
  entries.sort((a, b) => a.order - b.order || a.folder.localeCompare(b.folder));
  // Through normalize once more so two folders that ended up with the same id (a copy-pasted
  // folder) are separated rather than colliding in the scheduler.
  return normalizeJsScripts(entries.map((entry) => entry.script));
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

// Which script each folder currently holds. Rebuilt from the directory on every save rather than
// remembered, so a folder renamed outside the app is picked up instead of fought with. A folder
// we cannot identify is not ours: it is left alone, and never deleted.
async function currentFolders(dir: string): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  for (const folder of await listFolders(dir)) {
    let raw: unknown;
    try {
      raw = await readConfig(dir, folder);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim() && !byId.has(id.trim())) byId.set(id.trim(), folder);
  }
  return byId;
}

// Delete only the two files this store wrote, then the folder — which quietly fails if anything
// else is in there. A script folder is somewhere a user may reasonably keep a note or a data
// file, and deleting the script should not take those with it.
async function removeScriptFolder(folder: string): Promise<void> {
  await rm(join(folder, SOURCE_FILE), { force: true });
  await rm(join(folder, CONFIG_FILE), { force: true });
  try {
    await rmdir(folder);
  } catch {
    // Not empty — the user's own files stay, and so does the folder around them.
  }
}

// script.js is a file people open in an editor and commit, so it ends with a newline. normalize
// has already trimmed the source, so this adds exactly one.
function sourceText(source: string): string {
  return source ? `${source}\n` : "";
}

async function writeAll(dir: string, scripts: JsScript[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const current = await currentFolders(dir);

  // Scripts the user deleted: their folder is no longer claimed by any id. Done first, so a name
  // being freed here is available to a script moving onto it below.
  const live = new Set(scripts.map((script) => script.id));
  for (const [id, folder] of current) {
    if (live.has(id)) continue;
    await removeScriptFolder(join(dir, folder));
    current.delete(id);
  }

  // Folder names in use by something that is not a script of ours, so a rename never lands on a
  // directory we did not create.
  const mine = new Set(current.values());
  const reserved = new Set((await listFolders(dir)).filter((folder) => !mine.has(folder)));
  const wanted = scriptFolderNames(scripts, reserved);

  // Renames happen in two halves so that two scripts can swap names without either landing on
  // the other: everything that moves goes to a staging name first, and only then to its own.
  const staged: [string, string][] = [];
  for (const script of scripts) {
    const from = current.get(script.id);
    const to = wanted.get(script.id) as string;
    if (from === undefined || from === to) continue;
    const via = `${join(dir, to)}${MOVING_SUFFIX}${script.id.slice(0, 8)}`;
    await rename(join(dir, from), via);
    staged.push([via, join(dir, to)]);
  }
  for (const [via, to] of staged) await rename(via, to);

  // The index is the list order, which is what the Scripts tab shows; a directory has none.
  for (const [index, script] of scripts.entries()) {
    const folder = join(dir, wanted.get(script.id) as string);
    await mkdir(folder, { recursive: true });
    await writeTextFileAtomic(join(folder, SOURCE_FILE), sourceText(script.source));
    await writeTextFileAtomic(join(folder, CONFIG_FILE), serializeJsScriptConfig(script, index));
  }
}

const serialized = createSerializedWriter();

// Whole-list replace, like the old single file: the caller always sends every script, and one
// missing from the list is one the user deleted. Serialized, because a save is many file
// operations and two overlapping autosaves would interleave their renames.
export function saveJsScripts(dir: string, scripts: JsScript[]): Promise<void> {
  return serialized(() => writeAll(dir, scripts));
}

// ---------------------------------------------------------------------------
// Migration from the old single file
// ---------------------------------------------------------------------------

export function legacyJsScriptsPath(): string {
  return process.env.JS_SCRIPTS_PATH?.trim() || join(dataDir(), "js-scripts.json");
}

// Move js-scripts.json into the scripts directory, then delete it. Everything it held — sources,
// params, schedules — has been written out as files by then, so leaving it would only offer a
// second, stale copy of the same scripts for the next reader to disagree with.
//
// Only called when the directory holds no scripts at all, so this cannot overwrite folders that
// are already there. Returns how many scripts were moved.
export async function migrateLegacyJsScripts(dir: string): Promise<number> {
  const legacy = legacyJsScriptsPath();
  // A malformed legacy file throws here, before anything is written or deleted.
  const raw = await readJsonFile(legacy);
  if (raw === undefined) return 0;
  const scripts = parseJsScriptFile(raw);
  if (scripts.length > 0) await saveJsScripts(dir, scripts);
  await rm(legacy, { force: true });
  return scripts.length;
}
