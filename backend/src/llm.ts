import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import {
  buildFixPrompt,
  buildGenerationPrompt,
  buildJsonFixPrompt,
  buildRuntimeFixPrompt
} from "./prompts.js";
import type { GeneratedProject } from "./types.js";

export type StreamHandlers = {
  onReasoning?: (chunk: string) => void;
  onContent?: (chunk: string) => void;
  onStreamOpen?: () => void;
};

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
    if (timer) clearTimeout(timer);
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
    if (timer) clearTimeout(timer);
  }
}

export function createOpenAiClient(config: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    timeout: config.requestTimeoutMs
  });
}

export async function streamProjectCompletion(
  config: AppConfig,
  prompt: string,
  handlers: StreamHandlers = {}
): Promise<string> {
  const client = createOpenAiClient(config);

  const stream = await withTimeout(
    client.chat.completions.create({
      model: config.openaiModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 16384,
      stream: true,
      // NVIDIA / reasoning-model compatibility (ignored by OpenAI).
      reasoning_budget: 16384,
      chat_template_kwargs: { enable_thinking: true }
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming),
    config.requestTimeoutMs,
    `Model API request timed out after ${config.requestTimeoutMs / 1000}s — the endpoint may be overloaded or unavailable. Try a different OPENAI_MODEL.`
  );

  handlers.onStreamOpen?.();

  let content = "";
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

  return content;
}

export async function generateProjectFromIdea(
  config: AppConfig,
  idea: string,
  handlers: StreamHandlers = {}
): Promise<string> {
  return streamProjectCompletion(config, buildGenerationPrompt(idea), handlers);
}

export async function fixProjectFromValidationErrors(
  config: AppConfig,
  idea: string,
  project: GeneratedProject,
  validationError: string,
  handlers: StreamHandlers = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildFixPrompt(idea, project, validationError),
    handlers
  );
}

export async function fixProjectFromRuntimeError(
  config: AppConfig,
  idea: string,
  project: GeneratedProject,
  runtimeError: string,
  handlers: StreamHandlers = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildRuntimeFixPrompt(idea, project, runtimeError),
    handlers
  );
}

export async function fixInvalidJsonResponse(
  config: AppConfig,
  idea: string,
  invalidResponse: string,
  parseError: string,
  handlers: StreamHandlers = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildJsonFixPrompt(idea, parseError, invalidResponse),
    handlers
  );
}
