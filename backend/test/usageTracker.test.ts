import { describe, expect, it } from "vitest";
import { estimateTokensFromText, RunUsageTracker } from "../src/usageTracker.js";

describe("estimateTokensFromText", () => {
  it("uses a conservative characters-to-tokens estimate", () => {
    expect(estimateTokensFromText("abcde")).toBe(2);
    expect(estimateTokensFromText("")).toBe(1);
  });
});

describe("RunUsageTracker", () => {
  it("returns an empty snapshot before tokens stream", () => {
    const tracker = new RunUsageTracker(100);
    expect(tracker.snapshot()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextWindowTokens: 100,
      contextUsedTokens: 0,
      contextUsedPercent: 0,
      outputTokensPerSecond: 0,
      buckets: []
    });
  });

  it("tracks estimates and reconciles final provider usage", () => {
    const times = [0, 2000];
    const tracker = new RunUsageTracker(10, () => times.shift() ?? 2000);
    const callId = tracker.beginCall("generate");

    tracker.recordOutputEstimate(callId, "generate", 1);
    tracker.recordOutputEstimate(callId, "thinking", 2);
    const metrics = tracker.finalizeCall(callId, {
      kind: "generate",
      promptTokens: 8,
      completionTokens: 6,
      reasoningTokens: 2
    });

    expect(metrics.contextUsedPercent).toBe(100);
    expect(metrics.outputTokensPerSecond).toBe(3);
    expect(metrics.buckets).toEqual([
      {
        kind: "generate",
        label: "LLM generate",
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12
      },
      {
        kind: "thinking",
        label: "LLM thinking",
        inputTokens: 0,
        outputTokens: 2,
        totalTokens: 2
      }
    ]);
  });

  it("uses observed thinking estimates when usage omits reasoning details", () => {
    const tracker = new RunUsageTracker(100);
    const callId = tracker.beginCall("validation_fix");

    tracker.recordOutputEstimate(callId, "thinking", 2);
    const metrics = tracker.finalizeCall(callId, {
      kind: "validation_fix",
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 0
    });

    expect(metrics.buckets).toEqual([
      {
        kind: "thinking",
        label: "LLM thinking",
        inputTokens: 0,
        outputTokens: 2,
        totalTokens: 2
      },
      {
        kind: "validation_fix",
        label: "LLM validation fixes",
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13
      }
    ]);
  });

  it("finalizes calls that did not stream reasoning estimates", () => {
    const tracker = new RunUsageTracker(100);
    const callId = tracker.beginCall("runtime_fix");

    const metrics = tracker.finalizeCall(callId, {
      kind: "runtime_fix",
      promptTokens: 7,
      completionTokens: 2,
      reasoningTokens: 0
    });

    expect(metrics.buckets).toEqual([
      {
        kind: "runtime_fix",
        label: "LLM runtime fixes",
        inputTokens: 7,
        outputTokens: 2,
        totalTokens: 9
      }
    ]);
  });

  it("labels follow-up usage buckets", () => {
    const tracker = new RunUsageTracker(100);
    const callId = tracker.beginCall("follow_up");

    const metrics = tracker.finalizeCall(callId, {
      kind: "follow_up",
      promptTokens: 5,
      completionTokens: 3,
      reasoningTokens: 0
    });

    expect(metrics.buckets).toEqual([
      {
        kind: "follow_up",
        label: "LLM follow-up",
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8
      }
    ]);
  });

  it("clamps observed thinking estimates to completion tokens", () => {
    const tracker = new RunUsageTracker(100);
    const callId = tracker.beginCall("json_fix");

    tracker.recordOutputEstimate(callId, "thinking", 8);
    const metrics = tracker.finalizeCall(callId, {
      kind: "json_fix",
      promptTokens: 4,
      completionTokens: 3,
      reasoningTokens: 0
    });

    expect(metrics.outputTokens).toBe(3);
    expect(metrics.buckets[0]).toMatchObject({
      kind: "thinking",
      outputTokens: 3
    });
  });

  it("throws when updating an unknown call", () => {
    const tracker = new RunUsageTracker(100);
    expect(() => tracker.recordOutputEstimate("missing", "runtime_fix", 1)).toThrow(/not found/i);
    expect(() =>
      tracker.finalizeCall("missing", {
        kind: "runtime_fix",
        promptTokens: 1,
        completionTokens: 1,
        reasoningTokens: 0
      })
    ).toThrow(/not found/i);
  });

  it("detects when usage nears the configured threshold", () => {
    const tracker = new RunUsageTracker(100);
    expect(tracker.isNearLimit(0.9)).toBe(false);

    const callId = tracker.beginCall("generate");
    tracker.finalizeCall(callId, {
      kind: "generate",
      promptTokens: 80,
      completionTokens: 10,
      reasoningTokens: 0
    });

    expect(tracker.isNearLimit(0.9)).toBe(true);
    expect(tracker.isNearLimit(0.95)).toBe(false);
    expect(tracker.isNearLimit(0)).toBe(false);
  });

  it("tracks last prompt tokens and resets accumulated usage", () => {
    const tracker = new RunUsageTracker(100);
    const callId = tracker.beginCall("generate");
    tracker.finalizeCall(callId, {
      kind: "generate",
      promptTokens: 42,
      completionTokens: 8,
      reasoningTokens: 0
    });

    expect(tracker.getLastPromptTokens()).toBe(42);
    expect(tracker.snapshot().totalTokens).toBe(50);

    const resetMetrics = tracker.reset();
    expect(resetMetrics.totalTokens).toBe(0);
    expect(resetMetrics.contextUsedPercent).toBe(0);
    expect(tracker.getLastPromptTokens()).toBe(0);
    expect(tracker.getCompressionCount()).toBe(1);
  });

  it("labels context compression usage buckets", () => {
    const tracker = new RunUsageTracker(100);
    const callId = tracker.beginCall("context_compress");

    const metrics = tracker.finalizeCall(callId, {
      kind: "context_compress",
      promptTokens: 12,
      completionTokens: 4,
      reasoningTokens: 0
    });

    expect(metrics.buckets).toEqual([
      {
        kind: "context_compress",
        label: "LLM context compression",
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16
      }
    ]);
  });
});
