export type LlmUsageKind =
  | "generate"
  | "follow_up"
  | "thinking"
  | "json_fix"
  | "validation_fix"
  | "runtime_fix"
  | "context_compress";

export type RunContextState = {
  contextSummary?: string;
};

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

export type StreamChannel = "thinking" | "content";

export type RunStreams = Record<StreamChannel, string>;

export type SseMessage =
  | { type: "log"; line: string }
  | { type: "stream"; channel: StreamChannel; chunk: string }
  | { type: "usage"; metrics: RunUsageMetrics }
  | { type: "done"; files: Record<string, string> }
  | {
      type: "error";
      message: string;
      runId: string;
      files?: Record<string, string>;
      repairable?: boolean;
    }
  | { type: "stopped"; runId: string }
  | { type: "paused"; runId: string };

export type RunStatus = "pending" | "running" | "paused" | "done" | "error" | "cancelled";

export type RunPipelineKind = "generate" | "follow_up" | "runtime_repair" | "validation_repair";

export type RunPipelineStage = "llm" | "parse" | "validate";

export type RunCheckpoint = {
  kind: RunPipelineKind;
  stage: RunPipelineStage;
  idea: string;
  selectedModel?: string;
  skipValidation?: boolean;
  contextState: RunContextState;
  raw?: string;
  project?: GeneratedProject;
  sourceProject?: GeneratedProject;
  followUpPrompt?: string;
  runtimeError?: string;
  validationError?: string;
};

export type GenerationRun = {
  id: string;
  idea: string;
  status: RunStatus;
  logs: string[];
  streams: RunStreams;
  files: Record<string, string>;
  summary?: string;
  usage?: RunUsageMetrics;
  error?: string;
  checkpoint?: RunCheckpoint;
};

export type GeneratedProject = {
  files: Record<string, string>;
  summary: string;
};
