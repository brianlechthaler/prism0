import { describe, expect, it } from "vitest";
import {
  applyUsageUpdate,
  appendLogLine,
  appendStreamChunk,
  beginGeneratingState,
  completeGeneration,
  emptyRunStreams,
  extractValidationErrorFromLogs,
  failGeneration,
  isYoloRun,
  pauseGenerationState,
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
    const next = appendLogLine(
      { kind: "generating", runId: "r1", logs: ["a"], streams: emptyRunStreams() },
      "b"
    );
    expect(next).toEqual({
      kind: "generating",
      runId: "r1",
      logs: ["a", "b"],
      streams: emptyRunStreams()
    });
  });
});

describe("appendStreamChunk", () => {
  it("ignores stream chunks while idle", () => {
    expect(appendStreamChunk({ kind: "idle" }, "thinking", "x")).toEqual({ kind: "idle" });
  });

  it("accumulates stream chunks while generating", () => {
    const initial = { kind: "generating" as const, runId: "r1", logs: [], streams: emptyRunStreams() };
    const next = appendStreamChunk(
      appendStreamChunk(initial, "thinking", "plan"),
      "content",
      "{"
    );
    expect(next).toEqual({
      kind: "generating",
      runId: "r1",
      logs: [],
      streams: { thinking: "plan", content: "{" }
    });
  });
});

describe("completeGeneration", () => {
  it("handles idle state", () => {
    expect(completeGeneration({ kind: "idle" }, "r1", { "index.html": "<html/>" })).toEqual({
      kind: "ready",
      runId: "r1",
      logs: ["Ready."],
      streams: emptyRunStreams(),
      files: { "index.html": "<html/>" }
    });
  });

  it("preserves usage metrics", () => {
    expect(
      completeGeneration(
        { kind: "generating", runId: "r1", logs: [], streams: emptyRunStreams(), usage },
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
      logs: [],
      streams: emptyRunStreams()
    });
  });

  it("preserves usage metrics", () => {
    expect(
      failGeneration(
        { kind: "generating", runId: "r1", logs: [], streams: emptyRunStreams(), usage },
        "boom"
      ).usage
    ).toBe(usage);
  });

  it("preserves repairable run context", () => {
    expect(
      failGeneration(
        { kind: "generating", runId: "r1", logs: ["step"], streams: emptyRunStreams() },
        "lint still failing",
        {
          runId: "r1",
          files: { "index.js": "broken();" },
          repairable: true
        }
      )
    ).toEqual({
      kind: "error",
      message: "lint still failing",
      logs: ["step"],
      streams: emptyRunStreams(),
      runId: "r1",
      files: { "index.js": "broken();" },
      repairable: true
    });
  });
});

describe("extractValidationErrorFromLogs", () => {
  it("returns the last validation error line when present", () => {
    expect(
      extractValidationErrorFromLogs(
        [
          "[2026-01-01T00:00:00.000Z] Validation error: first failure",
          "[2026-01-01T00:00:01.000Z] Validation error: final failure"
        ],
        "fallback"
      )
    ).toBe("final failure");
  });

  it("falls back to the error message when no validation log exists", () => {
    expect(extractValidationErrorFromLogs(["Run failed"], "lint still failing")).toBe(
      "lint still failing"
    );
  });
});

describe("isYoloRun", () => {
  it("detects YOLO mode from skip, run, and follow-up log lines", () => {
    expect(isYoloRun(["YOLO mode: skipping validation harness (lint/tests)."])).toBe(true);
    expect(isYoloRun(["YOLO mode enabled for this run — validation harness will be skipped."])).toBe(
      true
    );
    expect(
      isYoloRun(["YOLO mode enabled for this follow-up — validation harness will be skipped."])
    ).toBe(true);
    expect(isYoloRun(["All checks passed."])).toBe(false);
  });
});

describe("beginGeneratingState", () => {
  const readyState = {
    kind: "ready" as const,
    runId: "r1",
    logs: ["done"],
    streams: { thinking: "plan", content: "{" },
    files: { "index.html": "<html/>" },
    usage
  };

  it("starts a fresh generation without prior progress", () => {
    expect(
      beginGeneratingState({ kind: "idle" }, { runId: "", logs: ["Starting…"] })
    ).toEqual({
      kind: "generating",
      runId: "",
      logs: ["Starting…"],
      streams: emptyRunStreams()
    });
  });

  it("preserves context usage and prior progress for follow-up style runs", () => {
    expect(
      beginGeneratingState(
        readyState,
        { runId: "", logs: ["Requesting follow-up changes…"] },
        { preserveProgress: true }
      )
    ).toEqual({
      kind: "generating",
      runId: "",
      logs: ["done", "Requesting follow-up changes…"],
      streams: { thinking: "plan", content: "{" },
      usage
    });
  });
});

describe("pauseGenerationState", () => {
  it("pauses from idle or error states", () => {
    expect(pauseGenerationState({ kind: "idle" }, "r1")).toEqual({
      kind: "paused",
      runId: "r1",
      logs: ["Paused."],
      streams: emptyRunStreams()
    });

    expect(
      pauseGenerationState(
        {
          kind: "error",
          message: "boom",
          logs: ["x"],
          streams: emptyRunStreams(),
          files: { "index.html": "<html/>" }
        },
        "r1"
      )
    ).toEqual({
      kind: "paused",
      runId: "r1",
      logs: ["x", "Paused."],
      streams: emptyRunStreams(),
      files: { "index.html": "<html/>" }
    });
  });

  it("preserves progress and marks the run as paused", () => {
    expect(
      pauseGenerationState(
        {
          kind: "generating",
          runId: "r1",
          logs: ["working"],
          streams: { thinking: "plan", content: "{" },
          usage
        },
        "r1"
      )
    ).toEqual({
      kind: "paused",
      runId: "r1",
      logs: ["working", "Paused."],
      streams: { thinking: "plan", content: "{" },
      usage
    });
  });
});

describe("applyUsageUpdate", () => {
  it("ignores updates while idle", () => {
    expect(applyUsageUpdate({ kind: "idle" }, usage)).toEqual({ kind: "idle" });
  });

  it("applies updates while a run is active", () => {
    expect(applyUsageUpdate({ kind: "generating", runId: "r1", logs: [], streams: emptyRunStreams() }, usage)).toEqual({
      kind: "generating",
      runId: "r1",
      logs: [],
      streams: emptyRunStreams(),
      usage
    });
  });
});
