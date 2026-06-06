import { describe, expect, it } from "vitest";
import { RunStore } from "../src/runStore.js";

describe("RunStore", () => {
  it("creates and retrieves runs", () => {
    const store = new RunStore();
    const run = store.create("make chess");
    expect(run.idea).toBe("make chess");
    expect(store.get(run.id)?.status).toBe("pending");
  });

  it("streams logs and completion events", () => {
    const store = new RunStore();
    const run = store.create("idea");
    const events: string[] = [];

    const unsubscribe = store.subscribe(run.id, (msg) => {
      events.push(msg.type);
    });

    store.appendLog(run.id, "step 1");
    store.complete(run.id, { "index.html": "<html/>" });

    expect(events).toEqual(["log", "done"]);
    unsubscribe();
  });

  it("replays state for late subscribers", () => {
    const store = new RunStore();
    const run = store.create("idea");
    store.appendLog(run.id, "hello");
    store.complete(run.id, { "index.js": "x" });

    const replay: string[] = [];
    store.subscribe(run.id, (msg) => replay.push(msg.type));
    expect(replay).toEqual(["log", "done"]);
  });

  it("replays unknown error message when details are missing", () => {
    const store = new RunStore();
    const run = store.create("idea");
    const internal = store as unknown as {
      runs: Map<string, { status: string; error?: string; logs: string[] }>;
    };
    const record = internal.runs.get(run.id)!;
    record.status = "error";

    const replay: string[] = [];
    store.subscribe(run.id, (msg) => {
      if (msg.type === "error") replay.push(msg.message);
    });
    expect(replay[0]).toBe("Unknown error");
  });

  it("emits error for failed runs", () => {
    const store = new RunStore();
    const run = store.create("idea");
    store.fail(run.id, "boom");

    const replay: string[] = [];
    store.subscribe(run.id, (msg) => replay.push(msg.type));
    expect(replay).toEqual(["error"]);
  });

  it("updates status and files", () => {
    const store = new RunStore();
    const run = store.create("idea");
    store.setStatus(run.id, "running");
    store.setFiles(run.id, { "index.js": "x" });
    expect(store.get(run.id)?.status).toBe("running");
    expect(store.get(run.id)?.files["index.js"]).toBe("x");
  });

  it("prunes the oldest completed runs when retention is exceeded", () => {
    let currentTime = 0;
    const store = new RunStore({ maxRuns: 2, now: () => ++currentTime });
    const oldRun = store.create("old");
    const activeRun = store.create("active");

    store.complete(oldRun.id, { "index.html": "<html/>" });
    const newestRun = store.create("new");

    expect(store.get(oldRun.id)).toBeUndefined();
    expect(store.get(activeRun.id)?.status).toBe("pending");
    expect(store.get(newestRun.id)?.status).toBe("pending");
  });

  it("prunes failed runs when retention is exceeded", () => {
    const store = new RunStore({ maxRuns: 1 });
    const failedRun = store.create("failed");

    store.fail(failedRun.id, "boom");
    const nextRun = store.create("next");

    expect(store.get(failedRun.id)).toBeUndefined();
    expect(store.get(nextRun.id)?.idea).toBe("next");
  });

  it("keeps active runs even when retention is exceeded", () => {
    const store = new RunStore({ maxRuns: 1 });
    const firstRun = store.create("first");
    const secondRun = store.create("second");

    expect(store.get(firstRun.id)?.idea).toBe("first");
    expect(store.get(secondRun.id)?.idea).toBe("second");
  });

  it("throws when run is missing", () => {
    const store = new RunStore();
    expect(() => store.subscribe("missing", () => {})).toThrow(/not found/i);
    expect(() => store.appendLog("missing", "x")).toThrow(/not found/i);
  });
});
