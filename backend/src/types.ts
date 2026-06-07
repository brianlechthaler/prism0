export type LlmUsageKind = "generate" | "thinking" | "json_fix" | "validation_fix" | "runtime_fix";

export type LlmCompletionUsage = {
  kind: Exclude<LlmUsageKind, "thinking">;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
};

export type LlmUsageBucket = {
  kind: LlmUsageKind;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type RunUsageMetrics = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindowTokens: number;
  contextUsedTokens: number;
  contextUsedPercent: number;
  outputTokensPerSecond: number;
  buckets: LlmUsageBucket[];
};

export type SseMessage =
  | { type: "log"; line: string }
  | { type: "usage"; metrics: RunUsageMetrics }
  | { type: "done"; files: Record<string, string> }
  | { type: "error"; message: string };

export type RunStatus = "pending" | "running" | "done" | "error";

export type GenerationRun = {
  id: string;
  idea: string;
  status: RunStatus;
  logs: string[];
  files: Record<string, string>;
  usage?: RunUsageMetrics;
  error?: string;
};

export type GeneratedProject = {
  files: Record<string, string>;
  summary: string;
};
