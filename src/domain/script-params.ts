// Template parameters for JS scripts: {{name}} holes in the source become fields in the Scripts
// tab, and params.name references are collected the same way. Pure — the renderer extracts fields
// as the user types, and the runner rewrites the source before spawning node.

export interface ScriptParam {
  // The identifier inside {{name}} / params.name — also the form field's label.
  name: string;
  // From {{name=default}}. "" when the hole has no default (or came from a params.name reference).
  defaultValue: string;
}

// {{dir}} or {{dir=/tmp}}. The default may be anything except a closing brace.
const PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)(?:=([^}]*))?\}\}/g;
const PARAMS_MEMBER_RE = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)/g;

function cloneRe(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags);
}

// Unique parameters, in the order they first appear. A later {{name=default}} fills in a default
// that an earlier bare {{name}} didn't have; params.name never invents a default of its own.
export function extractScriptParams(source: string): ScriptParam[] {
  const seen = new Map<string, ScriptParam>();
  const order: string[] = [];

  for (const match of source.matchAll(cloneRe(PLACEHOLDER_RE))) {
    const name = match[1];
    const defaultValue = match[2] ?? "";
    const existing = seen.get(name);
    if (!existing) {
      seen.set(name, { name, defaultValue });
      order.push(name);
    } else if (existing.defaultValue === "" && defaultValue !== "") {
      existing.defaultValue = defaultValue;
    }
  }

  for (const match of source.matchAll(cloneRe(PARAMS_MEMBER_RE))) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.set(name, { name, defaultValue: "" });
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

// Drop values for holes that are no longer in the source, so a renamed/removed {{param}} doesn't
// leave a ghost key in js-scripts.json.
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

// A schedule only arms when every extracted param has a non-empty resolved value (stored or default).
export function scriptParamsFilled(source: string, stored: Record<string, string>): boolean {
  const params = extractScriptParams(source);
  const values = resolveParamValues(params, stored);
  return params.every((param) => values[param.name].trim() !== "");
}

// Turn {{dir}} / {{dir=/tmp}} into params.dir so the prelude's object is the single source of values.
export function rewriteScriptSource(source: string): string {
  return source.replace(cloneRe(PLACEHOLDER_RE), (_match, name: string) => `params.${name}`);
}

// A runnable .mjs body: freeze the resolved params, then the rewritten user source. Placeholders
// become expressions (`params.dir`), not string pastes — values stay JSON-safe.
export function compileJsScript(source: string, stored: Record<string, string>): string {
  const params = extractScriptParams(source);
  const values = resolveParamValues(params, stored);
  const prelude = `const params = Object.freeze(${JSON.stringify(values)});\n`;
  return `${prelude}${rewriteScriptSource(source)}`;
}
