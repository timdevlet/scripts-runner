import { describe, expect, it } from "vitest";
import type { UpdateState } from "../src/domain/update.js";
import { createUpdateStore } from "../src/electron/renderer/src/stores/updateStore.js";

const available: UpdateState = {
  version: "0.2.0",
  mode: "install",
  phase: "available",
  percent: 0,
};

type CheckResult = { ok: true; update: UpdateState | null } | { ok: false; error: string };

// A controllable bridge: the test settles checks and pushes state by hand.
function stubBridge() {
  const checks: { resolve: (r: CheckResult) => void; reject: (e: unknown) => void }[] = [];
  let push: ((s: UpdateState) => void) | null = null;
  let subscriptions = 0;
  return {
    checks,
    emit: (s: UpdateState) => push?.(s),
    subscriptionCount: () => subscriptions,
    deps: {
      check: () =>
        new Promise<CheckResult>((resolve, reject) => {
          checks.push({ resolve, reject });
        }),
      onState: (cb: (s: UpdateState) => void) => {
        subscriptions++;
        push = cb;
        return () => {};
      },
    },
  };
}

describe("createUpdateStore", () => {
  it("starts empty and publishes the found update", async () => {
    const bridge = stubBridge();
    const store = createUpdateStore(bridge.deps);
    expect(store.getSnapshot()).toBeNull();

    store.ensureStarted();
    bridge.checks[0].resolve({ ok: true, update: available });
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual(available);
  });

  it("coalesces the doubled mount StrictMode causes into one check", () => {
    const bridge = stubBridge();
    const store = createUpdateStore(bridge.deps);
    store.ensureStarted();
    store.ensureStarted();
    expect(bridge.checks).toHaveLength(1);
    // And only one subscription to the main process's push, however many consumers mount.
    expect(bridge.subscriptionCount()).toBe(1);
  });

  it("lets a later mount retry after a failed check", async () => {
    const bridge = stubBridge();
    const store = createUpdateStore(bridge.deps);
    store.ensureStarted();
    bridge.checks[0].reject(new Error("offline"));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toBeNull();

    store.ensureStarted();
    expect(bridge.checks).toHaveLength(2);
  });

  it("does not re-check once an update is known", async () => {
    const bridge = stubBridge();
    const store = createUpdateStore(bridge.deps);
    store.ensureStarted();
    bridge.checks[0].resolve({ ok: true, update: available });
    await Promise.resolve();
    store.ensureStarted();
    expect(bridge.checks).toHaveLength(1);
  });

  it("notifies subscribers of download progress pushed from the main process", async () => {
    const bridge = stubBridge();
    const store = createUpdateStore(bridge.deps);
    const seen: (UpdateState | null)[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.ensureStarted();
    bridge.checks[0].resolve({ ok: true, update: available });
    await Promise.resolve();

    bridge.emit({ ...available, phase: "downloading", percent: 40 });
    bridge.emit({ ...available, phase: "downloaded", percent: 100 });
    expect(seen.map((s) => s?.phase)).toEqual(["available", "downloading", "downloaded"]);
    expect(store.getSnapshot()?.percent).toBe(100);
  });
});
