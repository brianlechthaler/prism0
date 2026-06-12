import { z } from "zod";
import type { CliArgs } from "./parseArgs.js";

const BooleanEnvSchema = z.enum(["true", "false", "1", "0"]).transform((value) => {
  return value === "true" || value === "1";
});

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_MODEL: z.string().min(1).optional(),
  OPENAI_MODELS: z.string().min(1).optional(),
  HOST: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().optional(),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  OPENAI_CONTEXT_WINDOW: z.coerce.number().int().positive().optional(),
  OPENAI_CONTEXT_COMPRESS_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
  MAX_RUNS: z.coerce.number().int().positive().optional(),
  MAX_ACTIVE_RUNS: z.coerce.number().int().positive().optional(),
  GENERATION_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
  GENERATION_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
  CORS_ORIGIN: z.string().min(1).optional(),
  TRUST_PROXY: BooleanEnvSchema.optional()
});

export function formatConfigIssues(
  issues: Array<{ path: Array<PropertyKey>; message: string }>
): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "env"}: ${issue.message}`)
    .join("; ");
}

export type AppConfig = {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiModels: string[];
  modelPickerEnabled: boolean;
  yoloModeEnabled: boolean;
  host: string;
  port: number;
  requestTimeoutMs: number;
  contextWindowTokens: number;
  contextCompressThreshold: number;
  maxRuns: number;
  maxActiveRuns: number;
  generationRateLimitWindowMs: number;
  generationRateLimitMax: number;
  corsOrigin?: string;
  trustProxy: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv, cli: CliArgs = {}): AppConfig {
  const merged = {
    OPENAI_API_KEY: cli.apiKey ?? env.OPENAI_API_KEY,
    OPENAI_BASE_URL: cli.baseUrl ?? env.OPENAI_BASE_URL,
    OPENAI_MODEL: cli.model ?? env.OPENAI_MODEL,
    OPENAI_MODELS: env.OPENAI_MODELS,
    HOST: cli.host ?? env.HOST,
    PORT: cli.port ?? env.PORT,
    REQUEST_TIMEOUT_MS: env.REQUEST_TIMEOUT_MS,
    OPENAI_CONTEXT_WINDOW: env.OPENAI_CONTEXT_WINDOW,
    OPENAI_CONTEXT_COMPRESS_THRESHOLD: env.OPENAI_CONTEXT_COMPRESS_THRESHOLD,
    MAX_RUNS: env.MAX_RUNS,
    MAX_ACTIVE_RUNS: env.MAX_ACTIVE_RUNS,
    GENERATION_RATE_LIMIT_WINDOW_MS: env.GENERATION_RATE_LIMIT_WINDOW_MS,
    GENERATION_RATE_LIMIT_MAX: env.GENERATION_RATE_LIMIT_MAX,
    CORS_ORIGIN: env.CORS_ORIGIN,
    TRUST_PROXY: env.TRUST_PROXY
  };

  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const msg = formatConfigIssues(parsed.error.issues);
    throw new Error(`Invalid configuration: ${msg}`);
  }

  if (!parsed.data.OPENAI_API_KEY) {
    throw new Error(
      "Invalid configuration: OPENAI_API_KEY: API key is required (set OPENAI_API_KEY or pass --api-key)"
    );
  }

  const openaiModel = parsed.data.OPENAI_MODEL ?? "gpt-4.1-mini";
  const modelPickerEnabled = cli.modelPickerEnabled ?? false;
  const yoloModeEnabled = cli.yoloModeEnabled ?? true;

  return {
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    openaiBaseUrl: parsed.data.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiModel,
    openaiModels: modelPickerEnabled ? parseModelList(openaiModel, parsed.data.OPENAI_MODELS) : [openaiModel],
    modelPickerEnabled,
    yoloModeEnabled,
    host: parsed.data.HOST ?? "0.0.0.0",
    port: parsed.data.PORT ?? 8787,
    requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_MS ?? 120_000,
    contextWindowTokens: parsed.data.OPENAI_CONTEXT_WINDOW ?? 128_000,
    contextCompressThreshold: parsed.data.OPENAI_CONTEXT_COMPRESS_THRESHOLD ?? 0.9,
    maxRuns: parsed.data.MAX_RUNS ?? 100,
    maxActiveRuns: parsed.data.MAX_ACTIVE_RUNS ?? 5,
    generationRateLimitWindowMs: parsed.data.GENERATION_RATE_LIMIT_WINDOW_MS ?? 60_000,
    generationRateLimitMax: parsed.data.GENERATION_RATE_LIMIT_MAX ?? 10,
    corsOrigin: parsed.data.CORS_ORIGIN,
    trustProxy: parsed.data.TRUST_PROXY ?? false
  };
}

export function parseModelList(defaultModel: string, rawModels?: string): string[] {
  const models = [
    defaultModel,
    ...(rawModels
      ?.split(",")
      .map((model) => model.trim())
      .filter(Boolean) ?? [])
  ];
  return [...new Set(models)];
}

