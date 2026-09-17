import { afterEach, describe, expect, it } from "vitest";
import { setLoginShellPath } from "../src/os/run-command.js";
import { runJsScript } from "../src/os/run-js-script.js";

afterEach(() => setLoginShellPath(null));

describe("runJsScript", () => {
  it("compiles the template, runs it with node, and captures stdout", async () => {
    // Tests run under node, so the current PATH already resolves it.
    setLoginShellPath(process.env.PATH ?? "");
    const out: { stream: string; text: string }[] = [];
    const handle = runJsScript(
      {
        source: "console.log({{msg}}); console.log(params.msg.toUpperCase());",
        paramValues: { msg: "hello" },
        cwd: "",
        timeoutSeconds: 15,
      },
      (stream, text) => out.push({ stream, text }),
    );
    const outcome = await handle.done;
    expect(outcome.code).toBe(0);
    expect(outcome.error).toBeUndefined();
    expect(out.filter((l) => l.stream === "stdout").map((l) => l.text)).toEqual(["hello", "HELLO"]);
  });

  it("surfaces a thrown error as a non-zero exit", async () => {
    setLoginShellPath(process.env.PATH ?? "");
    const handle = runJsScript(
      {
        source: "throw new Error({{msg}});",
        paramValues: { msg: "boom" },
        cwd: "",
        timeoutSeconds: 15,
      },
      () => {},
    );
    const outcome = await handle.done;
    expect(outcome.code).not.toBe(0);
  });
  // A secret reaches the script through the child's environment: {{K:secret}} compiles to a
  // process.env read, so the value is never written into the temp file this runs from.
  it("passes a secret through the environment, not the compiled body", async () => {
    setLoginShellPath(process.env.PATH ?? "");
    const out: string[] = [];
    const handle = runJsScript(
      {
        source: "console.log({{API_KEY:secret}}); console.log(typeof params.API_KEY);",
        paramValues: {},
        cwd: "",
        timeoutSeconds: 15,
        secrets: { API_KEY: "s3cret" },
      },
      (stream, text) => {
        if (stream === "stdout") out.push(text);
      },
    );
    expect((await handle.done).code).toBe(0);
    expect(out).toEqual(["s3cret", "undefined"]);
  });
});
