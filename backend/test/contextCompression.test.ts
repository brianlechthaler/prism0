import { afterEach, describe, expect, it, vi } from "vitest";
import {
  augmentIdeaWithContext,
  maybeCompressRunContext,
  parseContextSummaryResponse
} from "../src/contextCompression.js";
import { RunStore } from "../src/runStore.js";
import { RunUsageTracker } from "../src/usageTracker.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  openaiModels: ["m"],
  modelPickerEnabled: false,
  yoloModeEnabled: false,
  host: "127.0.0.1",
  port: 8787,
  requestTimeoutMs: 120_000,
  contextWindowTokens: 100,
  contextCompressThreshold: 0.9,
  maxRuns: 100,
  maxActiveRuns: 5,
  generationRateLimitWindowMs: 60_000,
  generationRateLimitMax: 10,
  trustProxy: false
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseContextSummaryResponse", () => {
  it("parses a JSON summary payload", () => {
    expect(parseContextSummaryResponse('{"summary":"Built a counter app with tests."}')).toBe(
      "Built a counter app with tests."
    );
  });

  it("extracts JSON from fenced model output", () => {
    expect(
      parseContextSummaryResponse('Here is the summary:\n```json\n{"summary":"ok"}\n```')
    ).toBe("ok");
  });

  it("parses raw summary text without braces", () => {
    expect(() => parseContextSummaryResponse("not json")).toThrow();
  });
});

describe("augmentIdeaWithContext", () => {
  it("returns the original idea when no summary exists", () => {
    expect(augmentIdeaWithContext("make counter")).toBe("make counter");
  });

  it("appends compressed context to the idea", () => {
    expect(augmentIdeaWithContext("make counter", "Counter with reset button.")).toContain(
      "Prior run context (compressed):"
    );
    expect(augmentIdeaWithContext("make counter", "Counter with reset button.")).toContain(
      "Counter with reset button."
    );
  });
});

describe("maybeCompressRunContext", () => {
  it("returns unchanged context when usage is below the threshold", async () => {
    const store = new RunStore();
    const run = store.create("make counter");
    const tracker = new RunUsageTracker(100);

    const result = await maybeCompressRunContext(
      config,
      store,
      tracker,
      run.id,
      run.idea,
      undefined,
      {},
      {}
    );

    expect(result).toEqual({ idea: run.idea, contextState: {} });
  });

  it("summarizes, resets usage, and augments the idea when near the limit", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "compressRunContextWithModel").mockResolvedValue(
      JSON.stringify({ summary: "Counter app with reset button." })
    );

    const store = new RunStore();
    const run = store.create("make counter");
    store.appendLog(run.id, "existing log line");
    const tracker = new RunUsageTracker(100);
    const callId = tracker.beginCall("generate");
    tracker.finalizeCall(callId, {
      kind: "generate",
      promptTokens: 90,
      completionTokens: 5,
      reasoningTokens: 0
    });

    const result = await maybeCompressRunContext(
      config,
      store,
      tracker,
      run.id,
      run.idea,
      { summary: "counter app", files: { "index.js": "export const count = 0;" } },
      { contextSummary: "older summary" },
      {},
      "m"
    );

    expect(llm.compressRunContextWithModel).toHaveBeenCalledTimes(1);
    expect(result.contextState.contextSummary).toBe("Counter app with reset button.");
    expect(result.idea).toContain("Counter app with reset button.");
    expect(tracker.snapshot().totalTokens).toBe(0);
    expect(store.get(run.id)?.logs.some((line) => line.includes("compressing run context"))).toBe(true);
    expect(store.get(run.id)?.logs.some((line) => line.includes("usage counter reset"))).toBe(true);
  });
});
