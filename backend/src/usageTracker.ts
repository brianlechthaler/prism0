import type { LlmCompletionUsage, LlmUsageBucket, LlmUsageKind, RunUsageMetrics } from "./types.js";

const USAGE_LABELS: Record<LlmUsageKind, string> = {
  generate: "LLM generate",
  thinking: "LLM thinking",
  json_fix: "LLM JSON fixes",
  validation_fix: "LLM validation fixes",
  runtime_fix: "LLM runtime fixes"
};

type ActiveCall = {
  kind: Exclude<LlmUsageKind, "thinking">;
  estimates: Partial<Record<LlmUsageKind, number>>;
};

export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class RunUsageTracker {
  private readonly buckets = new Map<LlmUsageKind, LlmUsageBucket>();
  private readonly activeCalls = new Map<string, ActiveCall>();
  private readonly contextWindowTokens: number;
  private readonly now: () => number;
  private callSequence = 0;
  private firstOutputAt: number | undefined;
  private lastOutputAt: number | undefined;

  constructor(contextWindowTokens: number, now: () => number = Date.now) {
    this.contextWindowTokens = contextWindowTokens;
    this.now = now;
  }

  beginCall(kind: Exclude<LlmUsageKind, "thinking">): string {
    const callId = `${kind}-${++this.callSequence}`;
    this.activeCalls.set(callId, { kind, estimates: {} });
    return callId;
  }

  recordOutputEstimate(callId: string, kind: LlmUsageKind, tokens: number): RunUsageMetrics {
    const call = this.requireCall(callId);
    call.estimates[kind] = (call.estimates[kind] ?? 0) + tokens;
    this.addOutput(kind, tokens);
    return this.snapshot();
  }

  finalizeCall(callId: string, usage: LlmCompletionUsage): RunUsageMetrics {
    const call = this.requireCall(callId);
    const estimatedPrimary = call.estimates[call.kind] ?? 0;
    const estimatedThinking = call.estimates.thinking ?? 0;
    const thinkingTokens = Math.min(
      usage.completionTokens,
      usage.reasoningTokens || estimatedThinking
    );
    const primaryOutputTokens = Math.max(0, usage.completionTokens - thinkingTokens);

    this.addInput(call.kind, usage.promptTokens);
    this.addOutput(call.kind, primaryOutputTokens - estimatedPrimary);
    this.addOutput("thinking", thinkingTokens - estimatedThinking);
    this.activeCalls.delete(callId);
    return this.snapshot();
  }

  snapshot(): RunUsageMetrics {
    const buckets = [...this.buckets.values()].filter((bucket) => bucket.totalTokens > 0);
    const inputTokens = buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
    const outputTokens = buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0);
    const totalTokens = inputTokens + outputTokens;
    const elapsedSeconds =
      this.firstOutputAt === undefined || this.lastOutputAt === undefined
        ? 0
        : Math.max((this.lastOutputAt - this.firstOutputAt) / 1000, 1);
    const outputTokensPerSecond = outputTokens === 0 ? 0 : outputTokens / elapsedSeconds;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      contextWindowTokens: this.contextWindowTokens,
      contextUsedTokens: totalTokens,
      contextUsedPercent: Math.min(100, (totalTokens / this.contextWindowTokens) * 100),
      outputTokensPerSecond,
      buckets: buckets.map((bucket) => ({ ...bucket }))
    };
  }

  private addInput(kind: LlmUsageKind, tokens: number): void {
    const bucket = this.bucket(kind);
    bucket.inputTokens += tokens;
    bucket.totalTokens += tokens;
  }

  private addOutput(kind: LlmUsageKind, tokens: number): void {
    const bucket = this.bucket(kind);
    bucket.outputTokens += tokens;
    bucket.totalTokens += tokens;
    if (tokens > 0) {
      const currentTime = this.now();
      this.firstOutputAt ??= currentTime;
      this.lastOutputAt = currentTime;
    }
  }

  private bucket(kind: LlmUsageKind): LlmUsageBucket {
    const existing = this.buckets.get(kind);
    if (existing) return existing;

    const bucket: LlmUsageBucket = {
      kind,
      label: USAGE_LABELS[kind],
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    this.buckets.set(kind, bucket);
    return bucket;
  }

  private requireCall(callId: string): ActiveCall {
    const call = this.activeCalls.get(callId);
    if (!call) throw new Error(`LLM usage call not found: ${callId}`);
    return call;
  }
}
