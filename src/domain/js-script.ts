// Pure types & policy for the Scripts tab: the stored JS-template shape, the per-script config
// file that sits next to its source on disk, and the bundle format used for export/import. No
// I/O — the file adapter is src/js-script-store.ts.

import { DEFAULT_TIMEOUT_SECONDS, normalizeTimeoutSeconds } from "./duration.js";
import { pruneParamValues } from "./script-params.js";

// One user-defined JS template. Every field is always present (no optionals) for the same reason
// ScheduledCommand is: the renderer edits this shape directly, stores it verbatim, and exports it.
export interface JsScript {
  // Stable id, minted when the row is added. React key, run/delete identity, and run-log key.
  id: string;
  // Display name shown in the list ("" renders as "Untitled script").
  name: string;
  // The JS template body. {{name}} holes are extracted to UI fields and rewritten at run time.
  source: string;
  // Last-used (or typed) values for extracted params. Keys not currently in the source are dropped
  // on normalize. Missing keys fall back to a template default at run time.
  paramValues: Record<string, string>;
  // A 5-field cron expression. "" = no schedule: the script only ever runs from the ▶ button.
  cron: string;
  // Whether the schedule is armed. New scripts start disabled so nothing runs before it's been
  // looked at. A schedule also stays disarmed until every extracted param has a value.
  enabled: boolean;
  // Working directory for the run. "" = the app's own cwd.
  cwd: string;
  // Kill the node process (and everything it started) if it's still running after this many seconds.
  // 0 = unlimited. Same default/coercion as ScheduledCommand.
  timeoutSeconds: number;
}

// Starter body for "+ Add script": a real template so the {{dir}} field appears immediately.
export const EXAMPLE_JS_SCRIPT = `// {{name}} placeholders become fields in the panel.
// They're JS expressions — interpolate with \${params.name}.

import fs from "node:fs";

const files = fs.readdirSync({{dir}});
for (const name of files) console.log(name);
`;

export function emptyJsScript(id: string): JsScript {
  return {
    id,
    name: "",
    source: EXAMPLE_JS_SCRIPT,
    paramValues: {},
    cron: "",
    enabled: false,
    cwd: "",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
}

export function jsScriptLabel(script: Pick<JsScript, "name" | "source">): string {
  const name = script.name.trim();
  if (name) return name;
  const source = script.source.trim();
  if (!source) return "Untitled script";
  const first =
    source.split("\n").find((line) => line.trim() && !line.trim().startsWith("//")) ?? source;
  const compact = first.trim();
  return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeParamValues(value: unknown, source: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return pruneParamValues(source, {});
  }
  const stored: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") stored[key] = entry;
  }
  return pruneParamValues(source, stored);
}

export function normalizeJsScripts(value: unknown): JsScript[] {
  if (!Array.isArray(value)) return [];
  const result: JsScript[] = [];
  const seenIds = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    let id = str(entry.id).trim() || `script-${result.length + 1}`;
    while (seenIds.has(id)) id = `${id}-2`;
    seenIds.add(id);
    const source = str(entry.source).trim();
    result.push({
      id,
      name: str(entry.name).trim(),
      source,
      paramValues: normalizeParamValues(entry.paramValues, source),
      cron: str(entry.cron).trim(),
      enabled: entry.enabled === true,
      cwd: str(entry.cwd).trim(),
      timeoutSeconds: normalizeTimeoutSeconds(entry.timeoutSeconds),
    });
  }
  return result;
}

export const JS_SCRIPT_FILE_VERSION = 1;

export interface JsScriptFile {
  version: number;
  scripts: JsScript[];
}

export function parseJsScriptFile(value: unknown): JsScript[] {
  if (Array.isArray(value)) return normalizeJsScripts(value);
  if (typeof value === "object" && value !== null) {
    return normalizeJsScripts((value as Record<string, unknown>).scripts);
  }
  return [];
}

export function serializeJsScriptFile(scripts: JsScript[]): string {
  const file: JsScriptFile = { version: JS_SCRIPT_FILE_VERSION, scripts };
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// On-disk layout: one folder per script
// ---------------------------------------------------------------------------

// A script is stored as two files in its own folder — the raw source, and everything else. The
// split is the point: script.js is a plain .js file an editor, a linter or git can work with,
// with no JSON escaping in the way.
export const JS_SCRIPT_CONFIG_VERSION = 1;

// Everything about a script except its source. `id` is the identity — the folder name is only a
// label, so renaming a script moves its folder without costing it its run history.
export interface JsScriptConfig {
  version: number;
  id: string;
  name: string;
  // Position in the Scripts list. A directory has no order of its own, so without this the list
  // would re-sort itself alphabetically the first time it was read back.
  order: number;
  paramValues: Record<string, string>;
  cron: string;
  enabled: boolean;
  cwd: string;
  timeoutSeconds: number;
}

// Names Windows refuses to give a file or folder, whatever the extension. A script called "con"
// would otherwise produce a folder that cannot be created there.
const RESERVED_FOLDER_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

// Longest slug we'll produce. Leaves room inside Windows' 260-character path cap for the data
// dir, the "-2" a collision adds, and "/script.json".
const MAX_FOLDER_SLUG = 60;

// The folder a script lives in: a slug of its display name, so the directory is readable in an
// editor. An untitled script falls back to its id — slugging the source instead would rename the
// folder on every keystroke.
export function scriptFolderName(script: Pick<JsScript, "id" | "name">): string {
  const slug = script.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_FOLDER_SLUG)
    .replace(/-+$/, "");
  if (!slug || RESERVED_FOLDER_NAMES.has(slug)) return `script-${script.id.slice(0, 8) || "1"}`;
  return slug;
}

// One folder name per script id, guaranteed distinct. Two scripts sharing a name get -2, -3… in
// list order, and `reserved` (folders already in the directory that belong to no script) is
// stepped around rather than renamed onto.
export function scriptFolderNames(
  scripts: readonly Pick<JsScript, "id" | "name">[],
  reserved: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const taken = new Set(reserved);
  const names = new Map<string, string>();
  for (const script of scripts) {
    const base = scriptFolderName(script);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    names.set(script.id, name);
  }
  return names;
}

export function serializeJsScriptConfig(script: JsScript, order: number): string {
  const config: JsScriptConfig = {
    version: JS_SCRIPT_CONFIG_VERSION,
    id: script.id,
    name: script.name,
    order,
    paramValues: pruneParamValues(script.source, script.paramValues),
    cron: script.cron,
    enabled: script.enabled,
    cwd: script.cwd,
    timeoutSeconds: script.timeoutSeconds,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

// Rebuild one script from its two files. `fallbackId` is the folder name: a config that has lost
// its id still names a script rather than dropping out of the list. `order` comes back separately
// because it orders the list rather than belonging to any one script.
export function parseJsScriptConfig(
  raw: unknown,
  source: string,
  fallbackId: string,
): { script: JsScript; order: number } {
  const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const [script] = normalizeJsScripts([
    { ...entry, id: str(entry.id).trim() || fallbackId, source },
  ]);
  // A config written by hand may have no order at all; those sort last, by folder name.
  const order =
    typeof entry.order === "number" && Number.isFinite(entry.order)
      ? entry.order
      : Number.MAX_SAFE_INTEGER;
  return { script, order };
}
