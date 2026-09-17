// The secret vault: named values (API keys, tokens) kept out of the files that describe a command
// or a script, so those stay safe to commit, export and share. Pure — the store writes the file,
// the scheduler injects the values, this module decides what a name is and how a reference reads.
//
// A job never holds a secret's value, only its name:
//
//   Commands tab   curl -H "key: {{STEAM_GRID_API_KEY}}" https://…
//   Scripts tab    const key = {{STEAM_GRID_API_KEY:secret}}
//
// Both are resolved through the child process's environment rather than by pasting the value in
// (see rewriteCommandSecrets, and compileJsScript in script-params.ts). That keeps the value off
// the command line — where `ps` and a quoting mistake can both reach it — and out of the temp .mjs
// a script run leaves on disk.

// Vault entries are environment variable names: what the shell and process.env can both address.
// Same shape as a script param, so a {{name:secret}} hole reads like every other hole.
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A bare {{NAME}} reference — in a shell command, or in the value typed into a script's parameter
// field. Whitespace inside the braces is allowed ({{ DB_API_KEY }} is what people write), but a
// hole with a :kind or an =default is a script param, not a secret, and is deliberately left alone.
const COMMAND_SECRET_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// What a secret's value is replaced with in captured output. Distinctive enough to notice, and
// not something a shell would produce on its own.
export const REDACTED = "••••••";

export const SECRETS_FILE_VERSION = 1;

export interface SecretsFile {
  version: number;
  // name → value. Values only ever exist in the main process: the renderer is told which names
  // are set, never what they hold.
  secrets: Record<string, string>;
}

// "" when the name is usable, otherwise why it isn't — shown under the field as the user types.
export function secretNameError(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "Name the secret first.";
  if (!SECRET_NAME_RE.test(trimmed)) {
    return "Letters, digits and underscores only, starting with a letter or underscore.";
  }
  return "";
}

// Keep only well-formed name/string pairs. A hand-edited file with a number, a null or a name the
// shell couldn't address loses that entry rather than the whole vault.
export function normalizeSecrets(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const secrets: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string" || secretNameError(name) !== "") continue;
    secrets[name.trim()] = raw;
  }
  return secrets;
}

// Accepts the versioned envelope and a bare { NAME: value } map alike, so a file written by hand
// works without the ceremony.
export function parseSecretsFile(value: unknown): Record<string, string> {
  if (typeof value === "object" && value !== null && "secrets" in value) {
    return normalizeSecrets((value as { secrets: unknown }).secrets);
  }
  return normalizeSecrets(value);
}

export function serializeSecretsFile(secrets: Record<string, string>): string {
  const file: SecretsFile = { version: SECRETS_FILE_VERSION, secrets };
  return `${JSON.stringify(file, null, 2)}\n`;
}

// The secrets a piece of text references, in first-appearance order, without duplicates. Used for
// a command line and for a parameter's stored value alike.
export function extractSecretRefs(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(COMMAND_SECRET_RE))) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    names.push(match[1]);
  }
  return names;
}

// Turn {{NAME}} into the shell's own way of reading an environment variable, which is how the
// value reaches the command — it is exported into the child's environment, never substituted here.
//
// The POSIX form expands inside double quotes and not inside single quotes, exactly like any other
// $VAR, so `curl -H "key: {{K}}"` works and `curl -H 'key: {{K}}'` does not. cmd.exe expands
// %NAME% in both.
export function rewriteCommandSecrets(command: string, windows: boolean): string {
  return command.replace(new RegExp(COMMAND_SECRET_RE), (_match, name: string) =>
    windows ? `%${name}%` : `$${name}`,
  );
}

// A parameter value with references in it, as a JS expression: a lone reference becomes the
// process.env read itself, and one mixed with text becomes a concatenation. Either way the value
// is read from the environment when the script runs, so the compiled file on disk holds the
// reference's *name*, never what it stands for. A value with no reference is a plain JSON string.
export function compileSecretRefs(value: string): string {
  const pieces: string[] = [];
  let last = 0;
  for (const match of value.matchAll(new RegExp(COMMAND_SECRET_RE))) {
    if (match.index > last) pieces.push(JSON.stringify(value.slice(last, match.index)));
    pieces.push(`process.env.${match[1]}`);
    last = match.index + match[0].length;
  }
  if (pieces.length === 0) return JSON.stringify(value);
  if (last < value.length) pieces.push(JSON.stringify(value.slice(last)));
  return pieces.join(" + ");
}

// The subset of the vault a job may see: its own referenced names and nothing else, so one script
// leaking its environment can't take every other script's keys with it.
export function pickSecrets(
  vault: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    if (Object.hasOwn(vault, name)) picked[name] = vault[name];
  }
  return picked;
}

// Names the job asks for that the vault doesn't have. A run is refused rather than started with
// the variable unset, which a shell would quietly expand to nothing.
export function missingSecrets(vault: Record<string, string>, names: readonly string[]): string[] {
  return names.filter((name) => !Object.hasOwn(vault, name) || vault[name] === "");
}

// Replace every secret value in captured output. Longest first, so a value that contains another
// (a key and its prefix) can't be half-masked. Applied to every line a run produces, because the
// run log is also the Logs tab and the terminal in dev — one `echo $KEY` would otherwise undo the
// whole point of keeping the value out of the config files.
export function redactSecrets(text: string, values: Iterable<string>): string {
  let out = text;
  const sorted = [...values].filter((value) => value !== "").sort((a, b) => b.length - a.length);
  for (const value of sorted) out = out.split(value).join(REDACTED);
  return out;
}
