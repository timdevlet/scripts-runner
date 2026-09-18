import { describe, expect, it } from "vitest";
import { applyTab, findMatches, lineCount } from "../src/electron/renderer/src/lib/js-editor.js";
import { type JsToken, tokenizeJs } from "../src/electron/renderer/src/lib/js-highlight.js";

const joined = (tokens: JsToken[]) => tokens.map((t) => t.text).join("");
const ofKind = (tokens: JsToken[], kind: JsToken["kind"]) =>
  tokens.filter((t) => t.kind === kind).map((t) => t.text);

describe("tokenizeJs", () => {
  it("is lossless for a mixed script", () => {
    const source = [
      "const dir = {{dir=/tmp}};",
      "/* block",
      "comment */",
      "console.log(`hi $" + "{params.dir}` + \"x\" + 'y'); // tail",
      "return 0x2a + 1.5 + .25;",
    ].join("\n");
    expect(joined(tokenizeJs(source))).toBe(source);
  });

  it("colors keywords, comments, strings and numbers", () => {
    const tokens = tokenizeJs('const n = 3; // ok\nlet s = "hi";');
    expect(ofKind(tokens, "keyword")).toEqual(["const", "let"]);
    expect(ofKind(tokens, "number")).toEqual(["3"]);
    expect(ofKind(tokens, "comment")).toEqual(["// ok"]);
    expect(ofKind(tokens, "string")).toEqual(['"hi"']);
  });

  it("colors {{param}} holes, including defaults", () => {
    const tokens = tokenizeJs("fs.readdirSync({{dir=/var}})");
    expect(ofKind(tokens, "param")).toEqual(["{{dir=/var}}"]);
    expect(joined(tokens)).toBe("fs.readdirSync({{dir=/var}})");
  });

  it("colors the annotated forms too, so the highlight matches what the extractor accepts", () => {
    const source = "go({{on:bool=true}}, {{pick:one(a|b)=a}}, {{d:dir=/tmp}}, {{s:many(x|y)}})";
    const tokens = tokenizeJs(source);
    expect(ofKind(tokens, "param")).toEqual([
      "{{on:bool=true}}",
      "{{pick:one(a|b)=a}}",
      "{{d:dir=/tmp}}",
      "{{s:many(x|y)}}",
    ]);
    expect(joined(tokens)).toBe(source);
  });

  it("colors params as a keyword", () => {
    expect(ofKind(tokenizeJs("params.dir"), "keyword")).toEqual(["params"]);
  });

  it("tokenizes interpolations inside template literals as JS, not string", () => {
    const tokens = tokenizeJs("`hello $" + "{name + 1}`");
    expect(ofKind(tokens, "string")).toEqual(["`hello ", "`"]);
    expect(ofKind(tokens, "number")).toEqual(["1"]);
    expect(tokens.some((t) => t.kind === "text" && t.text.includes("name"))).toBe(true);
  });

  it("keeps an unclosed string as a string token", () => {
    const source = '"oops';
    const tokens = tokenizeJs(source);
    expect(tokens).toEqual([{ kind: "string", text: '"oops' }]);
  });

  it("returns a single text token for punctuation-only input", () => {
    expect(tokenizeJs("=>")).toEqual([{ kind: "text", text: "=>" }]);
  });
});

describe("applyTab", () => {
  it("inserts two spaces at the caret", () => {
    expect(applyTab("ab", 1, 1, false)).toEqual({ value: "a  b", start: 3, end: 3 });
  });

  it("indents every selected line", () => {
    expect(applyTab("a\nb\n", 0, 3, false)).toEqual({
      value: "  a\n  b\n",
      start: 2,
      end: 7,
    });
  });

  it("unindents the current line on Shift+Tab", () => {
    expect(applyTab("  hello", 4, 4, true)).toEqual({
      value: "hello",
      start: 2,
      end: 2,
    });
  });

  it("does not pull the next line into an indent when the selection ends on a newline", () => {
    expect(applyTab("a\nb", 0, 2, false)).toEqual({
      value: "  a\nb",
      start: 2,
      end: 4,
    });
  });
});

describe("findMatches", () => {
  it("finds overlapping-adjacent runs without overlapping the ranges", () => {
    expect(findMatches("aaa", "aa")).toEqual([{ start: 0, end: 2 }]);
  });

  it("is case-insensitive and literal", () => {
    expect(findMatches("Foo FOO foo", "foo")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it("treats regex punctuation as plain text", () => {
    expect(findMatches("a.*b a.c", "a.*b")).toEqual([{ start: 0, end: 4 }]);
  });

  it("returns nothing for an empty query", () => {
    expect(findMatches("hello", "")).toEqual([]);
  });

  it("keeps offsets in the source's own units when lowercasing would change the length", () => {
    // "İ".toLowerCase() is two code units; a match after it must not shift by one.
    expect(findMatches("İ foo", "foo")).toEqual([{ start: 2, end: 5 }]);
  });
});
describe("lineCount", () => {
  it("counts one line for empty source", () => {
    expect(lineCount("")).toBe(1);
  });

  it("counts a trailing newline as an extra line", () => {
    expect(lineCount("a\n")).toBe(2);
  });
});
