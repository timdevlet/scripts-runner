// Tab / Shift+Tab for the Scripts code editor. Two spaces, matching biome's indent.

export const JS_INDENT = "  ";

export function applyTab(
  value: string,
  start: number,
  end: number,
  unindent: boolean,
  indent = JS_INDENT,
): { value: string; start: number; end: number } {
  if (!unindent && start === end) {
    return {
      value: value.slice(0, start) + indent + value.slice(end),
      start: start + indent.length,
      end: start + indent.length,
    };
  }

  const from = value.lastIndexOf("\n", start - 1) + 1;
  let to = value.indexOf("\n", end);
  if (to === -1) to = value.length;
  // A selection that ends on a newline shouldn't pull in the following (unselected) line.
  if (end > from && value[end - 1] === "\n") to = end - 1;

  const lines = value.slice(from, to).split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const next = lines.map((line, i) => {
    if (unindent) {
      const stripped = stripIndent(line, indent);
      if (i === 0) firstDelta = stripped;
      totalDelta += stripped;
      return line.slice(stripped);
    }
    if (i === 0) firstDelta = indent.length;
    totalDelta += indent.length;
    return indent + line;
  });

  return {
    value: value.slice(0, from) + next.join("\n") + value.slice(to),
    start: Math.max(from, start + (unindent ? -firstDelta : firstDelta)),
    end: Math.max(from, end + (unindent ? -totalDelta : totalDelta)),
  };
}

function stripIndent(line: string, indent: string): number {
  if (line.startsWith(indent)) return indent.length;
  if (line.startsWith("\t")) return 1;
  if (line.startsWith(" ")) return 1;
  return 0;
}

export function lineCount(value: string): number {
  if (value.length === 0) return 1;
  let n = 1;
  for (let i = 0; i < value.length; i++) if (value[i] === "\n") n++;
  return n;
}

export type TextMatch = { start: number; end: number };

// Literal, case-insensitive, non-overlapping — the Scripts editor's "find in text".
export function findMatches(source: string, query: string): TextMatch[] {
  if (!query) return [];
  const hay = source.toLowerCase();
  const needle = query.toLowerCase();
  const matches: TextMatch[] = [];
  let from = 0;
  while (from < hay.length) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    matches.push({ start: i, end: i + needle.length });
    from = i + needle.length;
  }
  return matches;
}

// Must match `line-height` / `padding` on `.code-editor-input` in CodeEditor.scss.
const LINE_HEIGHT = 18;
const PADDING = 8;
const CHAR_WIDTH = 7.2;

export function scrollEditorToOffset(
  source: string,
  offset: number,
  viewHeight: number,
  viewWidth: number,
): { top: number; left: number } {
  const line = lineCount(source.slice(0, offset)) - 1;
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const col = offset - lineStart;
  const y = PADDING + line * LINE_HEIGHT;
  const x = PADDING + col * CHAR_WIDTH;
  return {
    top: Math.max(0, y - Math.floor(viewHeight / 3)),
    left: Math.max(0, x - Math.floor(viewWidth / 3)),
  };
}
