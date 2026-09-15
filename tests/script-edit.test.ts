import { describe, expect, it } from "vitest";
import { editFileName } from "../src/electron/script-edit.js";

// The temp file's name is what VS Code shows on the tab, so it has to read as the script — and
// still be a legal filename whatever the user called it.
describe("editFileName", () => {
  const script = (name: string, source = "", id = "abcdef12-3456-7890") => ({ id, name, source });

  it("names the file after the script, suffixed with enough id to stay unique", () => {
    expect(editFileName(script("Steam BG to Wide Cover"))).toBe(
      "steam-bg-to-wide-cover-abcdef12.js",
    );
  });

  it("strips punctuation rather than emitting it into a filename", () => {
    expect(editFileName(script("Back up: ~/Pictures (weekly)!"))).toBe(
      "back-up-pictures-weekly-abcdef12.js",
    );
  });

  it("falls back to the first real line of source when there is no name", () => {
    expect(editFileName(script("", "// a comment\nconsole.log(1)\n"))).toBe(
      "console-log-1-abcdef12.js",
    );
  });

  it("still produces a usable name when nothing survives the slug", () => {
    expect(editFileName(script("!!! ???"))).toBe("script-abcdef12.js");
    expect(editFileName(script(""))).toBe("untitled-script-abcdef12.js");
  });

  it("caps the name so a rambling first line can't make an unopenable path", () => {
    const long = editFileName(script("x".repeat(200)));
    expect(long).toBe(`${"x".repeat(40)}-abcdef12.js`);
  });
});
