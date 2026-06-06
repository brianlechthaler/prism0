import { describe, expect, it } from "vitest";
import {
  applyUsageUpdate,
  appendLogLine,
  completeGeneration,
  failGeneration,
  type RunUsageMetrics
} from "../src/hooks/useGeneration";

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

describe("appendLogLine", () => {
  it("ignores logs while idle", () => {
    const next = appendLogLine({ kind: "idle" }, "skip me");
    expect(next).toEqual({ kind: "idle" });
  });

  it("appends logs while generating", () => {
    const next = appendLogLine({ kind: "generating", runId: "r1", logs: ["a"] }, "b");
    expect(next).toEqual({ kind: "generating", runId: "r1", logs: ["a", "b"] });
  });
});

describe("completeGeneration", () => {
  it("handles idle state", () => {
    expect(completeGeneration({ kind: "idle" }, "r1", { "index.html": "<html/>" })).toEqual({
      kind: "ready",
      runId: "r1",
      logs: ["Ready."],
      files: { "index.html": "<html/>" }
    });
  });

  it("preserves usage metrics", () => {
    expect(
      completeGeneration(
        { kind: "generating", runId: "r1", logs: [], usage },
        "r1",
        { "index.html": "<html/>" }
      ).usage
    ).toBe(usage);
  });
});

describe("failGeneration", () => {
  it("handles idle state", () => {
    expect(failGeneration({ kind: "idle" }, "boom")).toEqual({
      kind: "error",
      message: "boom",
      logs: []
    });
  });

  it("preserves usage metrics", () => {
    expect(failGeneration({ kind: "generating", runId: "r1", logs: [], usage }, "boom").usage).toBe(
      usage
    );
  });
});

describe("applyUsageUpdate", () => {
  it("ignores updates while idle", () => {
    expect(applyUsageUpdate({ kind: "idle" }, usage)).toEqual({ kind: "idle" });
  });

  it("applies updates while a run is active", () => {
    expect(applyUsageUpdate({ kind: "generating", runId: "r1", logs: [] }, usage)).toEqual({
      kind: "generating",
      runId: "r1",
      logs: [],
      usage
    });
  });
});
