import { describe, expect, it } from "vitest";
import {
  extractSecretRefs,
  missingSecrets,
  normalizeSecrets,
  parseSecretsFile,
  pickSecrets,
  redactSecrets,
  rewriteCommandSecrets,
  secretNameError,
  serializeSecretsFile,
} from "../src/domain/secrets.js";

describe("secretNameError", () => {
  it("accepts the names a shell and process.env can both address", () => {
    expect(secretNameError("DB_API_KEY")).toBe("");
    expect(secretNameError("_private2")).toBe("");
  });

  it("rejects a blank name, a leading digit, and punctuation", () => {
    expect(secretNameError("   ")).not.toBe("");
    expect(secretNameError("2FA_TOKEN")).not.toBe("");
    expect(secretNameError("DB-API-KEY")).not.toBe("");
    expect(secretNameError("DB KEY")).not.toBe("");
  });
});

describe("normalizeSecrets", () => {
  it("drops entries that aren't a usable name and a string value", () => {
    expect(normalizeSecrets({ GOOD: "value", "bad-name": "value", NUMBER: 7, NULL: null })).toEqual(
      { GOOD: "value" },
    );
  });

  // A vault the app can't understand reads as empty rather than throwing here; the store is what
  // decides whether an unreadable file is an error.
  it("reads a non-object as an empty vault", () => {
    expect(normalizeSecrets(null)).toEqual({});
    expect(normalizeSecrets("KEY=value")).toEqual({});
  });
});

describe("parseSecretsFile", () => {
  it("round-trips what serializeSecretsFile writes", () => {
    const secrets = { DB_API_KEY: "s3cret", TOKEN: "t0ken" };
    expect(parseSecretsFile(JSON.parse(serializeSecretsFile(secrets)))).toEqual(secrets);
  });

  it("accepts a bare name/value map, so the file can be written by hand", () => {
    expect(parseSecretsFile({ DB_API_KEY: "s3cret" })).toEqual({ DB_API_KEY: "s3cret" });
  });
});

describe("extractSecretRefs", () => {
  it("collects {{NAME}} references once each, in order, spaces and all", () => {
    expect(extractSecretRefs("curl -H 'k: {{TOKEN}}' {{ URL_KEY }} {{TOKEN}}")).toEqual([
      "TOKEN",
      "URL_KEY",
    ]);
  });

  // Those are script-param syntax. A command has no params, but leaving them alone keeps the two
  // template languages from quietly overlapping.
  it("ignores a hole with a kind or a default", () => {
    expect(extractSecretRefs("run {{opt:bool}} {{dir=/tmp}}")).toEqual([]);
  });
});

describe("rewriteCommandSecrets", () => {
  it("turns a reference into the shell's own variable read", () => {
    expect(rewriteCommandSecrets('curl -H "key: {{TOKEN}}"', false)).toBe('curl -H "key: $TOKEN"');
    expect(rewriteCommandSecrets('curl -H "key: {{ TOKEN }}"', true)).toBe(
      'curl -H "key: %TOKEN%"',
    );
  });

  // The value is exported into the child's environment instead — the point being that it never
  // appears in the command line, where `ps` would show it to every user on the machine.
  it("never substitutes the value itself", () => {
    expect(rewriteCommandSecrets("echo {{TOKEN}}", false)).not.toContain("{{");
  });
});

describe("pickSecrets", () => {
  it("passes on only the entries the job named", () => {
    const vault = { A: "1", B: "2", C: "3" };
    expect(pickSecrets(vault, ["A", "C", "MISSING"])).toEqual({ A: "1", C: "3" });
  });
});

describe("missingSecrets", () => {
  it("reports names the vault doesn't hold, and ones held empty", () => {
    expect(missingSecrets({ SET: "v", EMPTY: "" }, ["SET", "EMPTY", "ABSENT"])).toEqual([
      "EMPTY",
      "ABSENT",
    ]);
  });
});

describe("redactSecrets", () => {
  it("masks every occurrence of a value", () => {
    expect(redactSecrets("key=abc123 again abc123", ["abc123"])).toBe("key=•••••• again ••••••");
  });

  // Longest first: masking "abc" first would leave "123" of the longer key exposed beside a mask.
  it("masks the longest value first when one contains another", () => {
    expect(redactSecrets("abc123", ["abc", "abc123"])).toBe("••••••");
  });

  it("leaves output alone when nothing is set", () => {
    expect(redactSecrets("nothing to hide", ["", ...[]])).toBe("nothing to hide");
  });
});
