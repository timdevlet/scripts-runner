// Lightweight JS highlighter for the Scripts editor. Lossless: every character of the source lands
// in exactly one token, so the overlay behind the textarea stays aligned with what the user typed.
// Not a full parser — regex literals are left as punctuation / identifiers, which is enough for
// the size of scripts this editor is for.

export type JsTokenKind = "keyword" | "string" | "comment" | "number" | "param" | "text";

export interface JsToken {
  kind: JsTokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
  // Magic object the runner injects for {{param}} values.
  "params",
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

// {{dir}}, {{dir=/tmp}}, {{dir:one(a|b)=a}} — same shape as PLACEHOLDER_RE in
// domain/script-params.ts, anchored. Keep the two in sync: a hole the extractor accepts but this
// misses loses its highlight, and the reverse colours text the runner will never substitute.
const PARAM_RE = /^\{\{[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z]+(?:\([^)}]*\))?)?(?:=[^}]*)?\}\}/;

export function tokenizeJs(source: string): JsToken[] {
  const tokens: JsToken[] = [];
  tokenizeRange(source, 0, source.length, tokens, null);
  return tokens;
}

function push(tokens: JsToken[], kind: JsTokenKind, text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ kind, text });
}

function tokenizeRange(
  source: string,
  from: number,
  to: number,
  tokens: JsToken[],
  // When set, stop before a `}` that isn't nested inside this range — used for ${...} in templates.
  stopAtBrace: "}" | null,
): number {
  let i = from;
  let braceDepth = 0;

  while (i < to) {
    const c = source[i];

    // {{param}} holes before treating `{` as a brace (blocks, ${} interpolations).
    if (c === "{" && source[i + 1] === "{") {
      const match = source.slice(i).match(PARAM_RE);
      if (match) {
        push(tokens, "param", match[0]);
        i += match[0].length;
        continue;
      }
    }

    if (stopAtBrace && c === "}" && braceDepth === 0) return i;

    if (c === "{") {
      push(tokens, "text", c);
      braceDepth++;
      i++;
      continue;
    }
    if (c === "}") {
      push(tokens, "text", c);
      if (braceDepth > 0) braceDepth--;
      i++;
      continue;
    }

    if (c === "/" && source[i + 1] === "/") {
      let j = i + 2;
      while (j < to && source[j] !== "\n") j++;
      push(tokens, "comment", source.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const j = end === -1 || end >= to ? to : end + 2;
      push(tokens, "comment", source.slice(i, j));
      i = j;
      continue;
    }

    if (c === "'" || c === '"') {
      const j = readQuoted(source, i, to);
      push(tokens, "string", source.slice(i, j));
      i = j;
      continue;
    }
    if (c === "`") {
      i = readTemplate(source, i, to, tokens);
      continue;
    }

    if (DIGIT.test(c) || (c === "." && DIGIT.test(source[i + 1] ?? ""))) {
      const j = readNumber(source, i, to);
      push(tokens, "number", source.slice(i, j));
      i = j;
      continue;
    }

    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < to && IDENT_PART.test(source[j])) j++;
      const word = source.slice(i, j);
      push(tokens, KEYWORDS.has(word) ? "keyword" : "text", word);
      i = j;
      continue;
    }

    push(tokens, "text", c);
    i++;
  }

  return i;
}

function readQuoted(source: string, from: number, to: number): number {
  const quote = source[from];
  let i = from + 1;
  while (i < to) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return to;
}

function readTemplate(source: string, from: number, to: number, tokens: JsToken[]): number {
  let i = from + 1;
  let chunk = from;
  while (i < to) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "`") {
      push(tokens, "string", source.slice(chunk, i + 1));
      return i + 1;
    }
    if (source[i] === "$" && source[i + 1] === "{") {
      push(tokens, "string", source.slice(chunk, i));
      push(tokens, "text", "${");
      i += 2;
      i = tokenizeRange(source, i, to, tokens, "}");
      if (i < to && source[i] === "}") {
        push(tokens, "text", "}");
        i++;
      }
      chunk = i;
      continue;
    }
    i++;
  }
  push(tokens, "string", source.slice(chunk, to));
  return to;
}

function readNumber(source: string, from: number, to: number): number {
  let i = from;
  if (source[i] === "0" && i + 1 < to) {
    const next = source[i + 1];
    if (next === "x" || next === "X") return readWhile(source, i + 2, to, /[0-9a-fA-F_]/, true);
    if (next === "b" || next === "B") return readWhile(source, i + 2, to, /[01_]/, true);
    if (next === "o" || next === "O") return readWhile(source, i + 2, to, /[0-7_]/, true);
  }
  while (i < to && /[0-9_]/.test(source[i])) i++;
  if (source[i] === "." && DIGIT.test(source[i + 1] ?? "")) {
    i++;
    while (i < to && /[0-9_]/.test(source[i])) i++;
  }
  if (source[i] === "e" || source[i] === "E") {
    let j = i + 1;
    if (source[j] === "+" || source[j] === "-") j++;
    if (DIGIT.test(source[j] ?? "")) {
      i = j;
      while (i < to && /[0-9_]/.test(source[i])) i++;
    }
  }
  if (source[i] === "n") i++;
  return i;
}

function readWhile(
  source: string,
  from: number,
  to: number,
  re: RegExp,
  // Prefix (0x/0b/0o) is already consumed; if nothing follows it, still keep the prefix as a number.
  keepPrefix: boolean,
): number {
  let i = from;
  while (i < to && re.test(source[i])) i++;
  if (i === from && keepPrefix) return from;
  if (source[i] === "n") i++;
  return i;
}
