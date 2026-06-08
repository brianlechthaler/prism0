import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import {
  buildFixPrompt,
  buildFollowUpPrompt,
  buildGenerationPrompt,
  buildJsonFixPrompt,
  buildRuntimeFixPrompt
} from "./prompts.js";
import type { GeneratedProject, LlmCompletionUsage, LlmUsageKind } from "./types.js";

export type StreamHandlers = {
  onReasoning?: (chunk: string) => void;
  onContent?: (chunk: string) => void;
  onStreamOpen?: () => void;
  onUsage?: (usage: LlmCompletionUsage) => void;
  onModelAttempt?: (model: string, attempt: number, totalAttempts: number) => void;
  onModelFallback?: (failedModel: string, error: string, nextModel: string) => void;
};

export type ModelRequestOptions = {
  selectedModel?: string;
};

type LlmCallKind = Exclude<LlmUsageKind, "thinking">;

const STREAM_FIRST_CHUNK_MS = 120_000;
const STREAM_IDLE_CHUNK_MS = 60_000;
const STREAM_HARD_LIMIT_MS = 600_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function streamTimeoutError(sawFirstChunk: boolean, timeoutMs: number): Error {
  if (sawFirstChunk) {
    return new Error(`Model stream stalled: no new tokens for ${timeoutMs / 1000}s`);
  }
  return new Error(
    `No response from model within ${timeoutMs / 1000}s — the endpoint may be overloaded or unavailable. Try a different OPENAI_MODEL.`
  );
}

async function nextChunkWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  sawFirstChunk: boolean
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timer = setTimeout(
          () => reject(streamTimeoutError(sawFirstChunk, timeoutMs)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenAiClient(config: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    timeout: config.requestTimeoutMs
  });
}

export function getModelCandidates(config: AppConfig, selectedModel?: string): string[] {
  const preferredModel = selectedModel || config.openaiModel;
  return [preferredModel, ...config.openaiModels.filter((model) => model !== preferredModel)];
}

export async function streamProjectCompletion(
  config: AppConfig,
  prompt: string,
  kind: LlmCallKind,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  const models = getModelCandidates(config, options.selectedModel);
  let lastError: unknown = new Error("Model request failed");

  for (const [index, model] of models.entries()) {
    handlers.onModelAttempt?.(model, index + 1, models.length);
    try {
      return await streamProjectCompletionWithModel(config, prompt, kind, model, handlers);
    } catch (error) {
      lastError = error;
      const nextModel = models[index + 1];
      if (nextModel) {
        handlers.onModelFallback?.(model, errorMessage(error), nextModel);
      }
    }
  }

  throw lastError;
}

async function streamProjectCompletionWithModel(
  config: AppConfig,
  prompt: string,
  kind: LlmCallKind,
  model: string,
  handlers: StreamHandlers = {}
): Promise<string> {
  const client = createOpenAiClient(config);

  const stream = await withTimeout(
    client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 16384,
      stream: true,
      stream_options: { include_usage: true },
      // NVIDIA / reasoning-model compatibility (ignored by OpenAI).
      reasoning_budget: 16384,
      chat_template_kwargs: { enable_thinking: true }
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming),
    config.requestTimeoutMs,
    `Model API request timed out after ${config.requestTimeoutMs / 1000}s for ${model} — the endpoint may be overloaded or unavailable.`
  );

  handlers.onStreamOpen?.();

  let content = "";
  let usage: LlmCompletionUsage | undefined;
  let sawFirstChunk = false;
  const hardDeadline = Date.now() + STREAM_HARD_LIMIT_MS;
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    if (Date.now() > hardDeadline) {
      throw new Error(`Model stream exceeded hard limit of ${STREAM_HARD_LIMIT_MS / 1000}s`);
    }

    const timeoutMs = sawFirstChunk ? STREAM_IDLE_CHUNK_MS : STREAM_FIRST_CHUNK_MS;
    const { done, value: chunk } = await nextChunkWithTimeout(iterator, timeoutMs, sawFirstChunk);
    if (done) break;

    sawFirstChunk = true;
    usage = extractUsage(chunk, kind) ?? usage;
    const choice = chunk.choices[0];
    const delta = choice?.delta as { content?: string; reasoning_content?: string } | undefined;

    const reasoning = delta?.reasoning_content;
    if (reasoning) {
      handlers.onReasoning?.(reasoning);
    }

    const piece = delta?.content ?? "";
    if (piece) {
      content += piece;
      handlers.onContent?.(piece);
    }
  }

  if (!content.trim()) {
    throw new Error("Model returned an empty response");
  }

  if (usage) {
    handlers.onUsage?.(usage);
  }

  return content;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractUsage(chunk: unknown, kind: LlmCallKind): LlmCompletionUsage | undefined {
  const usage = (chunk as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;

  const candidate = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  const promptTokens = typeof candidate.prompt_tokens === "number" ? candidate.prompt_tokens : 0;
  const completionTokens =
    typeof candidate.completion_tokens === "number" ? candidate.completion_tokens : 0;
  const reasoningTokens =
    typeof candidate.completion_tokens_details?.reasoning_tokens === "number"
      ? candidate.completion_tokens_details.reasoning_tokens
      : 0;

  return { kind, promptTokens, completionTokens, reasoningTokens };
}

export async function generateProjectFromIdea(
  config: AppConfig,
  idea: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(config, buildGenerationPrompt(idea), "generate", handlers, options);
}

export async function updateProjectFromFollowUp(
  config: AppConfig,
  idea: string,
  project: GeneratedProject,
  followUpPrompt: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildFollowUpPrompt(idea, project, followUpPrompt),
    "follow_up",
    handlers,
    options
  );
}

export async function fixProjectFromValidationErrors(
  config: AppConfig,
  idea: string,
  project: GeneratedProject,
  validationError: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildFixPrompt(idea, project, validationError),
    "validation_fix",
    handlers,
    options
  );
}

export async function fixProjectFromRuntimeError(
  config: AppConfig,
  idea: string,
  project: GeneratedProject,
  runtimeError: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildRuntimeFixPrompt(idea, project, runtimeError),
    "runtime_fix",
    handlers,
    options
  );
}

export async function fixInvalidJsonResponse(
  config: AppConfig,
  idea: string,
  invalidResponse: string,
  parseError: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildJsonFixPrompt(idea, parseError, invalidResponse),
    "json_fix",
    handlers,
    options
  );
}
