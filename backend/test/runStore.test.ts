import { describe, expect, it } from "vitest";
import { RunStore } from "../src/runStore.js";
import type { RunUsageMetrics } from "../src/types.js";

const usage: RunUsageMetrics = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  contextWindowTokens: 100,
  contextUsedTokens: 15,
  contextUsedPercent: 15,
  outputTokensPerSecond: 2.5,
  buckets: [
    {
      kind: "generate",
      label: "LLM generate",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    }
  ]
};

describe("RunStore", () => {
  it("creates and retrieves runs", () => {
    const store = new RunStore();
    const run = store.create("make chess");
    expect(run.idea).toBe("make chess");
    expect(store.get(run.id)?.status).toBe("pending");
  });

  it("persists project summary on completion", () => {
    const store = new RunStore();
    const run = store.create("make chess");
    store.complete(run.id, { "index.html": "<html/>" }, "A playable chess board");

    expect(store.get(run.id)?.summary).toBe("A playable chess board");
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

  it("streams thinking and content chunks", () => {
    const store = new RunStore();
    const run = store.create("idea");
    const events: Array<{ type: string; channel?: string; chunk?: string }> = [];

    store.subscribe(run.id, (msg) => {
      events.push(msg);
    });

    store.appendStream(run.id, "thinking", "plan ");
    store.appendStream(run.id, "content", "{");

    expect(events).toEqual([
      { type: "stream", channel: "thinking", chunk: "plan " },
      { type: "stream", channel: "content", chunk: "{" }
    ]);
    expect(store.get(run.id)?.streams).toEqual({ thinking: "plan ", content: "{" });
  });

  it("ignores empty stream chunks", () => {
    const store = new RunStore();
    const run = store.create("idea");
    store.appendStream(run.id, "thinking", "");
    expect(store.get(run.id)?.streams.thinking).toBe("");
  });

  it("replays stream buffers for late subscribers", () => {
    const store = new RunStore();
    const run = store.create("idea");
    store.appendStream(run.id, "thinking", "reasoning");
    store.appendStream(run.id, "content", "code");

    const replay: string[] = [];
    store.subscribe(run.id, (msg) => {
      if (msg.type === "stream") replay.push(`${msg.channel}:${msg.chunk}`);
    });

    expect(replay).toEqual(["thinking:reasoning", "content:code"]);
  });

  it("replays state for late subscribers", () => {
    const store = new RunStore();
    const run = store.create("idea");
    store.appendLog(run.id, "hello");
    store.updateUsage(run.id, usage);
    store.complete(run.id, { "index.js": "x" });

    const replay: string[] = [];
    store.subscribe(run.id, (msg) => replay.push(msg.type));
    expect(replay).toEqual(["log", "usage", "done"]);
  });

  it("streams usage updates and snapshots are immutable", () => {
    const store = new RunStore();
    const run = store.create("idea");
    const events: string[] = [];

    store.subscribe(run.id, (msg) => {
      events.push(msg.type);
    });
    store.updateUsage(run.id, usage);

    const snapshot = store.get(run.id);
    snapshot?.usage?.buckets.push({
      kind: "thinking",
      label: "LLM thinking",
      inputTokens: 0,
      outputTokens: 1,
      totalTokens: 1
    });

    expect(events).toEqual(["usage"]);
    expect(store.get(run.id)?.usage?.buckets).toHaveLength(1);
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

  it("includes repairable files in failed run error events", () => {
    const store = new RunStore();
    const run = store.create("idea");
    store.setFiles(run.id, { "index.js": "broken();" });
    store.fail(run.id, "lint still failing");

    const replay: Array<{ type: string; files?: Record<string, string>; repairable?: boolean }> = [];
    store.subscribe(run.id, (msg) => {
      replay.push(msg);
    });

    expect(replay[0]).toMatchObject({
      type: "error",
      files: { "index.js": "broken();" },
      repairable: true
    });
  });

  it("updates status and files", () => {
    const store = new RunStore();
    const run = store.create("idea");
    store.setStatus(run.id, "running");
    store.setFiles(run.id, { "index.js": "x" });
    expect(store.get(run.id)?.status).toBe("running");
    expect(store.get(run.id)?.files["index.js"]).toBe("x");
  });

  it("counts pending and running runs as active", () => {
    const store = new RunStore();
    const pending = store.create("pending");
    const running = store.create("running");
    const done = store.create("done");
    const failed = store.create("failed");

    store.setStatus(running.id, "running");
    store.complete(done.id, { "index.html": "<html/>" });
    store.fail(failed.id, "boom");

    expect(store.activeCount()).toBe(2);
    expect(store.get(pending.id)?.status).toBe("pending");
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

  it("stops pruning when enough completed runs were removed", () => {
    let currentTime = 0;
    const store = new RunStore({ maxRuns: 2, now: () => ++currentTime });
    const oldRun = store.create("old");
    const retainedRun = store.create("retained");

    store.complete(oldRun.id, { "index.html": "old" });
    store.complete(retainedRun.id, { "index.html": "retained" });
    const newestRun = store.create("new");

    expect(store.get(oldRun.id)).toBeUndefined();
    expect(store.get(retainedRun.id)?.files["index.html"]).toBe("retained");
    expect(store.get(newestRun.id)?.idea).toBe("new");
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
    expect(() => store.appendStream("missing", "thinking", "x")).toThrow(/not found/i);
  });

  it("manages abort controllers and run control actions", () => {
    const store = new RunStore();
    const run = store.create("make app");
    store.setStatus(run.id, "running");

    const first = store.attachAbortController(run.id);
    const second = store.attachAbortController(run.id);
    expect(second).toBe(first);

    expect(store.isControllable(run.id)).toBe(true);
    expect(store.stop(run.id)).toBe(true);
    expect(first.signal.aborted).toBe(true);
    store.markStopped(run.id);
    expect(store.get(run.id)?.status).toBe("cancelled");

    const pausedRun = store.create("pause me");
    store.setStatus(pausedRun.id, "running");
    const pauseController = store.attachAbortController(pausedRun.id);
    expect(store.pause(pausedRun.id)).toBe(true);
    expect(pauseController.signal.aborted).toBe(true);
    store.markPaused(pausedRun.id, {
      kind: "generate",
      stage: "llm",
      idea: "pause me",
      contextState: {}
    });
    expect(store.get(pausedRun.id)?.status).toBe("paused");
    expect(store.getCheckpoint(pausedRun.id)?.idea).toBe("pause me");
    expect(store.isResumable(pausedRun.id)).toBe(true);

    const resumed = store.resume(pausedRun.id);
    expect(resumed?.idea).toBe("pause me");
    expect(store.get(pausedRun.id)?.status).toBe("running");
    expect(store.resume("missing")).toBeUndefined();
  });

  it("stops and pauses pending runs without abort controllers", () => {
    const store = new RunStore();
    const run = store.create("pending");

    expect(store.stop(run.id)).toBe(true);
    expect(store.get(run.id)?.status).toBe("cancelled");

    const pauseRun = store.create("pending pause");
    expect(store.pause(pauseRun.id)).toBe(true);
    expect(store.get(pauseRun.id)?.status).toBe("paused");
  });

  it("replays stopped and paused events for late subscribers", () => {
    const store = new RunStore();
    const stoppedRun = store.create("stopped");
    store.markStopped(stoppedRun.id);

    const stoppedEvents: string[] = [];
    store.subscribe(stoppedRun.id, (msg) => stoppedEvents.push(msg.type));
    expect(stoppedEvents).toEqual(["stopped"]);

    const pausedRun = store.create("paused");
    store.markPaused(pausedRun.id, {
      kind: "generate",
      stage: "llm",
      idea: "paused",
      contextState: {}
    });

    const pausedEvents: string[] = [];
    store.subscribe(pausedRun.id, (msg) => pausedEvents.push(msg.type));
    expect(pausedEvents).toEqual(["paused"]);
  });

  it("rejects control actions for inactive runs", () => {
    const store = new RunStore();
    const run = store.create("done");
    store.complete(run.id, { "index.html": "<html/>" });

    expect(store.stop(run.id)).toBe(false);
    expect(store.pause(run.id)).toBe(false);
    expect(store.isResumable(run.id)).toBe(false);
  });

  it("clears missing abort controllers safely", () => {
    const store = new RunStore();
    expect(() => store.clearAbortController("missing")).not.toThrow();

    const run = store.create("clear me");
    store.attachAbortController(run.id);
    store.clearAbortController(run.id);
    expect(store.getAbortSignal(run.id)).toBeUndefined();
  });

  it("reuses a fresh abort controller after the previous one was aborted", () => {
    const store = new RunStore();
    const run = store.create("retry");
    const first = store.attachAbortController(run.id);
    first.abort("stop");
    const next = store.attachAbortController(run.id);
    expect(next).not.toBe(first);
    expect(next.signal.aborted).toBe(false);
  });

  it("prunes cancelled runs when retention is exceeded", () => {
    const store = new RunStore({ maxRuns: 1 });
    const cancelledRun = store.create("cancelled");
    store.markStopped(cancelledRun.id);
    const nextRun = store.create("next");
    expect(store.get(cancelledRun.id)).toBeUndefined();
    expect(store.get(nextRun.id)?.idea).toBe("next");
  });
});
