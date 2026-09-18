// Template parameters for JS scripts: {{name}} holes in the source become fields in the Scripts
// tab, and params.name references are collected the same way. Pure — the renderer extracts fields
// as the user types, and the runner rewrites the source before spawning node.
//
// A hole may declare a kind, which decides the control the Scripts tab renders for it:
//
//   {{outDir}}                            text input   (the plain, untyped form)
//   {{outDir=/tmp/arts}}                  text input with a default
//   {{apply:bool=false}}                  toggle switch
//   {{outDir:dir=/tmp/arts}}              text input + Browse… (native directory picker)
//   {{pick:one(first|random|largest)}}    dropdown, one choice
//   {{styles:many(alternate|blurred)}}    checklist, any number of choices
//
// Whitespace inside the braces is ignored, so {{ outDir }} and {{outDir}} are the same hole.
//
// Values stay strings end to end — js-script.ts persists Record<string, string> and drops
// anything else — so a bool is "true"/"false" and a multi-select is a comma-joined list. Scripts
// read them as strings (`params.apply === "true"`), which is also what the untyped holes always
// did, so adding a kind to an existing hole never changes what the script receives.
//
// The secret vault (domain/secrets.ts) is reached from a field: typing {{DB_API_KEY}} as a param's
// value stores that *reference*, and the run resolves it as a process.env read against an
// environment the runner builds — so the value is never written to script.json and never pasted
// into the temp .mjs a run leaves on disk. Any param can carry one, so a script that takes an
// `apiKey` param gets a secret without being edited.

import { compileSecretRefs, extractSecretRefs } from "./secrets.js";

export type ScriptParamKind = "text" | "bool" | "dir" | "one" | "many";

const KINDS = new Set<string>(["text", "bool", "dir", "one", "many"]);

export interface ScriptParam {
  // The identifier inside {{name}} / params.name — also the form field's label.
  name: string;
  // Which control to render. "text" for a bare {{name}} and for an unrecognized annotation — a
  // typo degrades to the input that was always there rather than making the field vanish.
  kind: ScriptParamKind;
  // The choices for "one"/"many", in declaration order. Empty for every other kind.
  options: string[];
  // From {{name=default}}. "" when the hole has no default (or came from a params.name
  // reference), except for bool, which normalizes to "false".
  defaultValue: string;
}

// {{dir}}, {{dir=/tmp}}, {{dir:kind}}, {{dir:kind(a|b)}}, {{dir:kind(a|b)=a}}.
// The option list stops at the first ")" so the default after it is still its own group; the
// default itself may be anything except a closing brace. Whitespace between the braces and the
// parts is ignored — including around the default, which therefore can't begin or end with a
// space, the one thing this costs.
const PLACEHOLDER_RE =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z]+)\s*(?:\(([^)}]*)\))?\s*)?(?:=\s*([^}]*?))?\s*\}\}/g;
const PARAMS_MEMBER_RE = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)/g;

// What a checked toggle writes, and what a script should compare against. The reader is lenient
// because these values are also typed by hand into the source's `=default`.
const TRUTHY = new Set(["true", "1", "yes", "on"]);

export function isParamChecked(value: string): boolean {
  return TRUTHY.has(value.trim().toLowerCase());
}

// A "many" value is a comma-joined list. Blank entries are dropped so "a,,b" and a trailing
// comma both round-trip cleanly.
export function parseManyValue(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function formatManyValue(values: readonly string[]): string {
  return values.join(",");
}

function cloneRe(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags);
}

function parseKind(raw: string | undefined): ScriptParamKind {
  const kind = (raw ?? "").toLowerCase();
  return KINDS.has(kind) ? (kind as ScriptParamKind) : "text";
}

function parseOptions(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const options: string[] = [];
  for (const entry of raw.split("|")) {
    const option = entry.trim();
    if (option === "" || seen.has(option)) continue;
    seen.add(option);
    options.push(option);
  }
  return options;
}

// A bool's stored value is always exactly "true" or "false", so the toggle has a definite state
// and the value a script sees doesn't depend on how the default was spelled.
function normalizeDefault(kind: ScriptParamKind, raw: string): string {
  if (kind === "bool") return isParamChecked(raw) ? "true" : "false";
  return raw;
}

// Unique parameters, in the order they first appear. Later occurrences fill in what an earlier
// one left out — a default, a kind, an option list — so the annotation only has to be written
// once even when the hole is repeated; params.name never invents any of them.
export function extractScriptParams(source: string): ScriptParam[] {
  const seen = new Map<string, ScriptParam>();
  const order: string[] = [];

  for (const match of source.matchAll(cloneRe(PLACEHOLDER_RE))) {
    const name = match[1];
    const kind = parseKind(match[2]);
    const options = parseOptions(match[3]);
    const defaultValue = normalizeDefault(kind, match[4] ?? "");
    const existing = seen.get(name);
    if (!existing) {
      seen.set(name, { name, kind, options, defaultValue });
      order.push(name);
      continue;
    }
    if (existing.kind === "text" && kind !== "text") {
      existing.kind = kind;
      // The default was normalized against the kind we knew at the time; redo it now that the
      // hole has declared one, so {{ok}} … {{ok:bool=yes}} still ends up as "true".
      existing.defaultValue = normalizeDefault(kind, existing.defaultValue);
    }
    if (existing.options.length === 0 && options.length > 0) existing.options = options;
    if (existing.defaultValue === "" && defaultValue !== "") {
      existing.defaultValue = normalizeDefault(existing.kind, match[4] ?? "");
    }
  }

  for (const match of source.matchAll(cloneRe(PARAMS_MEMBER_RE))) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.set(name, { name, kind: "text", options: [], defaultValue: "" });
    order.push(name);
  }

  return order.map((name) => seen.get(name)!);
}

// What the script actually receives: stored values win, otherwise the template default.
export function resolveParamValues(
  params: ScriptParam[],
  stored: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of params) {
    values[param.name] = Object.hasOwn(stored, param.name)
      ? stored[param.name]
      : param.defaultValue;
  }
  return values;
}

// Every vault entry a script needs: the {{NAME}} references typed into its param values, in
// first-appearance order. What the runner exports into the environment, checks against the vault
// before a run, and masks in the output.
export function scriptSecretNames(source: string, stored: Record<string, string>): string[] {
  const names = new Set<string>();
  const params = extractScriptParams(source);
  const values = resolveParamValues(params, stored);
  for (const param of params) {
    for (const name of extractSecretRefs(values[param.name])) names.add(name);
  }
  return [...names];
}

// Drop values for holes that are no longer in the source, so a renamed/removed {{param}} doesn't
// leave a ghost key in script.json.
export function pruneParamValues(
  source: string,
  stored: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(extractScriptParams(source).map((param) => param.name));
  const pruned: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored)) {
    if (allowed.has(name)) pruned[name] = value;
  }
  return pruned;
}

// A schedule only arms when every extracted param has a value. "Has a value" means non-empty for
// the kinds a user types into — but an unchecked toggle ("false") and an empty checklist ("none
// of them") are answers, not blanks, so those kinds never block a schedule.
export function scriptParamsFilled(source: string, stored: Record<string, string>): boolean {
  const params = extractScriptParams(source);
  const values = resolveParamValues(params, stored);
  return params.every((param) => {
    if (param.kind === "bool" || param.kind === "many") return true;
    return values[param.name].trim() !== "";
  });
}

// Turn {{dir}} / {{dir=/tmp}} / {{dir:one(a|b)=a}} into params.dir so the prelude's object is the
// single source of values.
export function rewriteScriptSource(source: string): string {
  return source.replace(cloneRe(PLACEHOLDER_RE), (_match, name: string) => `params.${name}`);
}

// A runnable .mjs body: freeze the resolved params, then the rewritten user source. Placeholders
// become expressions (`params.dir`), not string pastes — values stay JSON-safe.
//
// Secrets never land in the frozen object. This body is written to a temp file on disk for the
// length of the run, so a value inlined here would be a plaintext copy of it. A param value
// holding a {{KEY}} reference is emitted as a process.env read rather than as a string.
export function compileJsScript(source: string, stored: Record<string, string>): string {
  const params = extractScriptParams(source);
  const values = resolveParamValues(params, stored);
  const entries = params.map(
    (param) => `${JSON.stringify(param.name)}:${compileSecretRefs(values[param.name])}`,
  );
  const prelude = `const params = Object.freeze({${entries.join(",")}});\n`;
  return `${prelude}${rewriteScriptSource(source)}`;
}
