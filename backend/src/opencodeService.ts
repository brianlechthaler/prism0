import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { createOpencodeServer } from "@opencode-ai/sdk/server";
import type { Config } from "@opencode-ai/sdk";
import type { AssistantMessage, Part, ToolState } from "@opencode-ai/sdk/client";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.js";
import { throwIfAborted, waitForAbort } from "./runControl.js";
import type { LlmCompletionUsage, LlmUsageKind } from "./types.js";

export type OpencodeStreamHandlers = {
  onReasoning?: (chunk: string) => void;
  onContent?: (chunk: string) => void;
  onStreamOpen?: () => void;
  onUsage?: (usage: LlmCompletionUsage) => void;
  onModelAttempt?: (model: string, attempt: number, totalAttempts: number) => void;
  onModelFallback?: (failedModel: string, error: string, nextModel: string) => void;
};

export type OpencodePromptOptions = {
  selectedModel?: string;
  signal?: AbortSignal;
  directory?: string;
};

type LlmCallKind = Exclude<LlmUsageKind, "thinking">;

const STREAM_FIRST_CHUNK_MS = 120_000;
const STREAM_IDLE_CHUNK_MS = 60_000;
const STREAM_HARD_LIMIT_MS = 600_000;
const OPENCODE_AGENT = "build";

const DISABLED_TOOLS: Record<string, boolean> = {
  bash: false,
  edit: false,
  write: false,
  read: false,
  grep: false,
  glob: false,
  list: false,
  patch: false,
  task: false
};

type OpencodeServerHandle = {
  url: string;
  close(): void;
};

let activeServer: OpencodeServerHandle | null = null;
let activeClient: OpencodeClient | null = null;
let activeConfigKey: string | null = null;

function backendRootDir(): string {
  return path.resolve(fileURLToPath(import.meta.url), "../..");
}

function workspaceRootDir(): string {
  return path.resolve(backendRootDir(), "..");
}

export function resolveOpencodeBinDir(
  exists: (targetPath: string) => boolean = existsSync
): string {
  const candidates = [
    path.join(workspaceRootDir(), "node_modules", ".bin"),
    path.join(backendRootDir(), "node_modules", ".bin")
  ];
  for (const candidate of candidates) {
    const binary = path.join(candidate, process.platform === "win32" ? "opencode.exe" : "opencode");
    if (exists(binary)) {
      return candidate;
    }
  }
  return candidates[0];
}

export function ensureOpencodeOnPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const binDir = resolveOpencodeBinDir();
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const current = env[pathKey] ?? "";
  if (current.split(path.delimiter).includes(binDir)) {
    return env;
  }
  return { ...env, [pathKey]: `${binDir}${path.delimiter}${current}` };
}

export function buildOpencodeConfig(config: AppConfig): Config {
  return {
    model: `openai/${config.openaiModel}`,
    provider: {
      openai: {
        options: {
          apiKey: config.openaiApiKey,
          baseURL: config.openaiBaseUrl,
          timeout: config.requestTimeoutMs
        }
      }
    },
    enabled_providers: ["openai"],
    disabled_providers: []
  };
}

function configCacheKey(config: AppConfig): string {
  return [
    config.openaiApiKey,
    config.openaiBaseUrl,
    config.openaiModel,
    config.requestTimeoutMs
  ].join("\0");
}

export function parseOpencodeModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash > 0) {
    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1)
    };
  }
  return { providerID: "openai", modelID: model };
}

export function getModelCandidates(config: AppConfig, selectedModel?: string): string[] {
  const preferredModel = selectedModel || config.openaiModel;
  return [preferredModel, ...config.openaiModels.filter((model) => model !== preferredModel)];
}

export async function getOpencodeClient(config: AppConfig): Promise<OpencodeClient> {
  const cacheKey = configCacheKey(config);
  if (activeClient && activeServer && activeConfigKey === cacheKey) {
    return activeClient;
  }

  await shutdownOpencode();

  const previousPath = process.env.PATH;
  ensureOpencodeOnPath();
  try {
    activeServer = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: 4096,
      timeout: 30_000,
      config: buildOpencodeConfig(config)
    });
    activeClient = createOpencodeClient({ baseUrl: activeServer.url });
    activeConfigKey = cacheKey;
    return activeClient;
  } finally {
    if (previousPath !== undefined) {
      process.env.PATH = previousPath;
    }
  }
}

export async function shutdownOpencode(): Promise<void> {
  activeClient = null;
  activeConfigKey = null;
  if (activeServer) {
    activeServer.close();
    activeServer = null;
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

async function nextEventWithTimeout<T>(
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

function normalizeOpencodeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/\b(\d{3})\b/);
  const statusCode = statusMatch?.[1];
  if (statusCode === "401" || statusCode === "403") {
    return `Model provider rejected the request (${statusCode}). Check OPENAI_API_KEY, OPENAI_BASE_URL, and model access permissions.`;
  }
  return message;
}

function extractTextFromParts(parts: Array<Part>): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function mapUsage(kind: LlmCallKind, tokens: {
  input: number;
  output: number;
  reasoning: number;
}): LlmCompletionUsage {
  return {
    kind,
    promptTokens: tokens.input,
    completionTokens: tokens.output,
    reasoningTokens: tokens.reasoning
  };
}

export async function runOpencodePrompt(
  config: AppConfig,
  prompt: string,
  kind: LlmCallKind,
  handlers: OpencodeStreamHandlers = {},
  options: OpencodePromptOptions = {}
): Promise<string> {
  const models = getModelCandidates(config, options.selectedModel);
  let lastError: Error = new Error("Model request failed");

  for (const [index, model] of models.entries()) {
    throwIfAborted(options.signal);
    handlers.onModelAttempt?.(model, index + 1, models.length);
    try {
      return await runOpencodePromptWithModel(
        config,
        prompt,
        kind,
        model,
        handlers,
        options.signal,
        options.directory
      );
    } catch (error) {
      lastError = new Error(normalizeOpencodeError(error));
      const nextModel = models[index + 1];
      if (nextModel) {
        handlers.onModelFallback?.(model, lastError.message, nextModel);
      }
    }
  }

  throw lastError;
}

export function abortOpencodeSession(client: OpencodeClient, sessionId: string): void {
  void client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
}

async function runOpencodePromptWithModel(
  config: AppConfig,
  prompt: string,
  kind: LlmCallKind,
  model: string,
  handlers: OpencodeStreamHandlers,
  signal?: AbortSignal,
  directory?: string
): Promise<string> {
  throwIfAborted(signal);
  const client = await getOpencodeClient(config);
  const session = await client.session.create({
    body: { title: `prism0-${kind}` },
    ...(directory ? { query: { directory } } : {})
  });
  const sessionId = session.data?.id;
  if (!sessionId) {
    throw new Error("OpenCode failed to create a generation session");
  }

  const eventStream = await client.event.subscribe(directory ? { query: { directory } } : undefined);
  const iterator = eventStream.stream[Symbol.asyncIterator]();
  let content = "";
  let sawFirstChunk = false;
  const hardDeadline = Date.now() + STREAM_HARD_LIMIT_MS;
  let usage: LlmCompletionUsage | undefined;
  let promptError: Error | undefined;

  handlers.onStreamOpen?.();

  const abortListener = signal ? () => abortOpencodeSession(client, sessionId) : undefined;
  if (signal && abortListener) {
    signal.addEventListener("abort", abortListener, { once: true });
  }

  const promptPromise = client.session
    .promptAsync({
      path: { id: sessionId },
      ...(directory ? { query: { directory } } : {}),
      body: {
        model: parseOpencodeModel(model),
        tools: DISABLED_TOOLS,
        parts: [{ type: "text", text: prompt }]
      }
    })
    .catch((error: unknown) => {
      promptError = new Error(normalizeOpencodeError(error));
    });

  try {
    while (true) {
      throwIfAborted(signal);
      if (Date.now() > hardDeadline) {
        await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
        throw new Error(`Model stream exceeded hard limit of ${STREAM_HARD_LIMIT_MS / 1000}s`);
      }

      const timeoutMs = sawFirstChunk ? STREAM_IDLE_CHUNK_MS : STREAM_FIRST_CHUNK_MS;
      const { done, value: event } = await Promise.race([
        nextEventWithTimeout(iterator, timeoutMs, sawFirstChunk),
        waitForAbort(signal)
      ]);

      if (done) break;

      if (event.type === "message.part.updated" && event.properties.part.sessionID === sessionId) {
        const part = event.properties.part;
        const delta = event.properties.delta;
        if (delta) {
          sawFirstChunk = true;
          if (part.type === "reasoning") {
            handlers.onReasoning?.(delta);
          }
          if (part.type === "text") {
            content += delta;
            handlers.onContent?.(delta);
          }
        }
      }

      if (event.type === "session.error" && event.properties.sessionID === sessionId) {
        const message =
          typeof event.properties.error === "string"
            ? event.properties.error
            : JSON.stringify(event.properties.error);
        throw new Error(normalizeOpencodeError(new Error(message)));
      }

      if (event.type === "session.idle" && event.properties.sessionID === sessionId) {
        break;
      }
    }
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }

  await promptPromise;
  if (promptError) {
    throw promptError;
  }

  const messages = await client.session.messages({
    path: { id: sessionId },
    ...(directory ? { query: { directory } } : {})
  });

  const assistantEntry = [...(messages.data ?? [])]
    .reverse()
    .find((entry): entry is { info: AssistantMessage; parts: Array<Part> } => entry.info.role === "assistant");

  if (assistantEntry?.info.error) {
    const apiError = assistantEntry.info.error;
    const message =
      "data" in apiError && typeof apiError.data?.message === "string"
        ? apiError.data.message
        : JSON.stringify(apiError);
    throw new Error(normalizeOpencodeError(new Error(message)));
  }

  if (!content.trim()) {
    content = extractTextFromParts(assistantEntry?.parts ?? []);
  }

  if (!content.trim()) {
    throw new Error("Model returned an empty response");
  }

  if (assistantEntry?.info.tokens) {
    usage = mapUsage(kind, assistantEntry.info.tokens);
    handlers.onUsage?.(usage);
  }

  await client.session.delete({ path: { id: sessionId } }).catch(() => undefined);
  return content;
}

export async function runOpencodeShell(
  config: AppConfig,
  command: string,
  cwd: string,
  onLog: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  const client = await getOpencodeClient(config);
  const session = await client.session.create({
    body: { title: "prism0-validation" },
    query: { directory: cwd }
  });
  const sessionId = session.data?.id;
  if (!sessionId) {
    throw new Error("OpenCode failed to create a validation session");
  }

  try {
    const result = await Promise.race([
      client.session.shell({
        path: { id: sessionId },
        query: { directory: cwd },
        body: {
          agent: OPENCODE_AGENT,
          command
        }
      }),
      waitForAbort(signal)
    ]);

    const shellData = result.data as { parts?: Array<{ type: string; state?: ToolState }> } | undefined;
    const parts = shellData?.parts ?? [];
    const toolPart = parts.find((part): part is { type: "tool"; state: ToolState } => part.type === "tool");
    if (!toolPart) {
      throw new Error(`OpenCode shell produced no command output for: ${command}`);
    }

    const state = toolPart.state;
    const output =
      state.status === "completed"
        ? state.output
        : state.status === "error"
          ? state.error
          : "";

    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      onLog(line);
    }

    if (state.status === "error") {
      throw new Error(output || `OpenCode shell command failed: ${command}`);
    }

    return output;
  } finally {
    await client.session.delete({ path: { id: sessionId } }).catch(() => undefined);
  }
}

export function createOpencodeClientHandle(config: AppConfig): { getClient: () => Promise<OpencodeClient> } {
  return {
    getClient: () => getOpencodeClient(config)
  };
}
