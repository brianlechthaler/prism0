import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { createOpencodeServer } from "@opencode-ai/sdk/server";
import type { Config } from "@opencode-ai/sdk";
import type { AssistantMessage, Part, ToolState } from "@opencode-ai/sdk/client";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
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

const OPENCODE_STUB_MARKER = "postinstall script was not run";

export function resolveOpencodePackageDir(
  exists: (targetPath: string) => boolean = existsSync
): string {
  const candidates = [
    path.join(workspaceRootDir(), "node_modules", "opencode-ai"),
    path.join(backendRootDir(), "node_modules", "opencode-ai")
  ];
  for (const candidate of candidates) {
    if (exists(path.join(candidate, "postinstall.mjs"))) {
      return candidate;
    }
  }
  return candidates[0];
}

export function resolveOpencodeBinaryPath(
  exists: (targetPath: string) => boolean = existsSync
): string {
  return path.join(resolveOpencodePackageDir(exists), "bin", "opencode.exe");
}

export function isOpencodeStub(
  binaryPath: string,
  readFile: (targetPath: string, options: { encoding: "utf8" }) => string = (targetPath, options) =>
    readFileSync(targetPath, options)
): boolean {
  try {
    return readFile(binaryPath, { encoding: "utf8" }).includes(OPENCODE_STUB_MARKER);
  } catch {
    return true;
  }
}

type OpencodeBinaryDeps = {
  spawnSync: typeof spawnSync;
  readFile: (targetPath: string, encoding: "utf8") => string;
  execPath: string;
  exists: (targetPath: string) => boolean;
  waitBeforeInstall?: () => Promise<void>;
};

function defaultOpencodeBinaryDeps(): OpencodeBinaryDeps {
  return {
    spawnSync,
    readFile: (targetPath, encoding) => readFileSync(targetPath, encoding),
    execPath: process.execPath,
    exists: existsSync
  };
}

let opencodeInstallPromise: Promise<void> | null = null;

export async function ensureOpencodeBinary(deps: OpencodeBinaryDeps = defaultOpencodeBinaryDeps()): Promise<void> {
  const binaryPath = resolveOpencodeBinaryPath(deps.exists);
  if (!isOpencodeStub(binaryPath, (targetPath) => deps.readFile(targetPath, "utf8"))) {
    return;
  }

  if (!opencodeInstallPromise) {
    opencodeInstallPromise = (async () => {
      if (deps.waitBeforeInstall) {
        await deps.waitBeforeInstall();
      }
      installOpencodeBinary(deps);
    })().finally(() => {
      opencodeInstallPromise = null;
    });
  }
  await opencodeInstallPromise;
}

export function installOpencodeBinary(deps: OpencodeBinaryDeps = defaultOpencodeBinaryDeps()): void {
  const postinstall = path.join(resolveOpencodePackageDir(deps.exists), "postinstall.mjs");
  const binaryPath = resolveOpencodeBinaryPath(deps.exists);
  const result = deps.spawnSync(deps.execPath, [postinstall], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() || "Failed to install the OpenCode CLI binary"
    );
  }
  if (isOpencodeStub(binaryPath, (targetPath) => deps.readFile(targetPath, "utf8"))) {
    throw new Error("OpenCode CLI binary is still missing after running postinstall");
  }
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

const OPENCODE_PROVIDER_ID = "llm";
const OPENCODE_OPENAI_PROVIDER_NPM = "@ai-sdk/openai-compatible";

export function buildOpencodeModelRegistry(config: AppConfig): NonNullable<Config["provider"]>[string]["models"] {
  const models = new Set([config.openaiModel, ...config.openaiModels]);
  const outputLimit = Math.min(16_384, Math.floor(config.contextWindowTokens / 4));
  const registry: NonNullable<Config["provider"]>[string]["models"] = {};

  for (const model of models) {
    registry[model] = {
      id: model,
      name: model,
      tool_call: true,
      limit: {
        context: config.contextWindowTokens,
        output: outputLimit
      }
    };
  }

  return registry;
}

export function buildOpencodeConfig(config: AppConfig): Config {
  return {
    model: `${OPENCODE_PROVIDER_ID}/${config.openaiModel}`,
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: OPENCODE_OPENAI_PROVIDER_NPM,
        models: buildOpencodeModelRegistry(config),
        options: {
          apiKey: config.openaiApiKey,
          baseURL: config.openaiBaseUrl,
          timeout: config.requestTimeoutMs
        }
      }
    },
    enabled_providers: [OPENCODE_PROVIDER_ID],
    disabled_providers: []
  };
}

function configCacheKey(config: AppConfig): string {
  return [
    config.openaiApiKey,
    config.openaiBaseUrl,
    config.openaiModel,
    config.openaiModels.join("\n"),
    config.contextWindowTokens,
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
  return { providerID: OPENCODE_PROVIDER_ID, modelID: model };
}

export function getModelCandidates(config: AppConfig, selectedModel?: string): string[] {
  const preferredModel = selectedModel || config.openaiModel;
  return [preferredModel, ...config.openaiModels.filter((model) => model !== preferredModel)];
}

const OPENCODE_HOST = "127.0.0.1";
const OPENCODE_PORT_ATTEMPTS = 8;

export function resolveListenPort(
  address: ReturnType<ReturnType<typeof createServer>["address"]>
): number {
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve an OpenCode server port");
  }
  return address.port;
}

export async function findAvailablePort(host = OPENCODE_HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      try {
        const port = resolveListenPort(server.address());
        server.close(() => resolve(port));
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
}

export async function startOpencodeServer(
  config: AppConfig,
  options: { hostname?: string; timeout?: number } = {}
): Promise<OpencodeServerHandle> {
  const hostname = options.hostname ?? OPENCODE_HOST;
  const timeout = options.timeout ?? 30_000;
  let lastError: Error = new Error("Failed to start OpenCode server");

  for (let attempt = 0; attempt < OPENCODE_PORT_ATTEMPTS; attempt++) {
    const port = await findAvailablePort(hostname);
    try {
      return await createOpencodeServer({
        hostname,
        port,
        timeout,
        config: buildOpencodeConfig(config)
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}

export async function getOpencodeClient(config: AppConfig): Promise<OpencodeClient> {
  const cacheKey = configCacheKey(config);
  if (activeClient && activeServer && activeConfigKey === cacheKey) {
    return activeClient;
  }

  await shutdownOpencode();

  const previousPath = process.env.PATH;
  const env = ensureOpencodeOnPath(process.env);
  if (env.PATH) {
    process.env.PATH = env.PATH;
  }
  try {
    await ensureOpencodeBinary();
    activeServer = await startOpencodeServer(config);
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
