// File adapter for JS script templates: js-scripts.json, kept in the app data dir.
//
// The shape and its coercion rules live in src/domain/js-script.ts.

import { join } from "node:path";
import {
  type JsScript,
  normalizeJsScripts,
  parseJsScriptFile,
  serializeJsScriptFile,
} from "./domain/js-script.js";
import { createSerializedWriter, readJsonFile, writeTextFileAtomic } from "./os/json-file.js";
import { dataDir } from "./paths.js";

export function jsScriptsPath(): string {
  return process.env.JS_SCRIPTS_PATH?.trim() || join(dataDir(), "js-scripts.json");
}

export async function loadJsScripts(): Promise<JsScript[]> {
  const raw = await readJsonFile(jsScriptsPath());
  if (raw === undefined) return [];
  return parseJsScriptFile(raw);
}

const serialized = createSerializedWriter();

export function saveJsScripts(scripts: JsScript[]): Promise<void> {
  return serialized(async () => {
    const text = serializeJsScriptFile(normalizeJsScripts(scripts));
    await writeTextFileAtomic(jsScriptsPath(), text);
  });
}
