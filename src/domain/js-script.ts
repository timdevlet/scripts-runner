// Pure types & policy for the Scripts tab: the stored JS-template shape, and the JSON file format
// used for both storage and export/import. No I/O — the file adapter is src/js-script-store.ts.

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
