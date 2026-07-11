import { afterEach, describe, expect, it, vi } from "vitest";

const { createOpencodeServer, createOpencodeClient, createServerMock } = vi.hoisted(() => ({
  createOpencodeServer: vi.fn(),
  createOpencodeClient: vi.fn(),
  createServerMock: vi.fn()
}));

vi.mock("@opencode-ai/sdk/server", () => ({ createOpencodeServer }));
vi.mock("@opencode-ai/sdk/client", () => ({ createOpencodeClient }));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  createServerMock.mockImplementation(actual.createServer);
  return {
    ...actual,
    createServer: createServerMock
  };
});

import {
  abortOpencodeSession,
  buildOpencodeConfig,
  ensureOpencodeOnPath,
  findAvailablePort,
  getModelCandidates,
  parseOpencodeModel,
  resolveListenPort,
  resolveOpencodeBinDir,
  runOpencodePrompt,
  runOpencodeShell,
  shutdownOpencode,
  startOpencodeServer
} from "../src/opencodeService.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "gpt-4.1-mini",
  openaiModels: ["gpt-4.1-mini"],
  modelPickerEnabled: false,
  yoloModeEnabled: false,
  host: "127.0.0.1",
  port: 8787,
  requestTimeoutMs: 120_000,
  contextWindowTokens: 128_000,
  contextCompressThreshold: 0.9,
  maxRuns: 100,
  maxActiveRuns: 5,
  generationRateLimitWindowMs: 60_000,
  generationRateLimitMax: 10,
  trustProxy: false
};

function createMockClient() {
  const sessionId = "ses_test";

  const client = {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: sessionId } }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              role: "assistant",
              tokens: { input: 10, output: 5, reasoning: 2 }
            },
            parts: [{ type: "text", text: "hello" }]
          }
        ]
      }),
      delete: vi.fn().mockResolvedValue({ data: true }),
      abort: vi.fn().mockResolvedValue({ data: true }),
      shell: vi.fn().mockResolvedValue({
        data: {
          parts: [
            {
              type: "tool",
              state: {
                status: "completed",
                output: "lint ok\n"
              }
            }
          ]
        }
      })
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "message.part.updated",
              properties: {
                part: { type: "text", sessionID: sessionId },
                delta: "hello"
              }
            };
            yield {
              type: "session.idle",
              properties: { sessionID: sessionId }
            };
          }
        }
      })
    }
  };

  return { client, sessionId };
}

describe("opencodeService", () => {
  afterEach(async () => {
    await shutdownOpencode();
    vi.restoreAllMocks();
    createOpencodeServer.mockReset();
    createOpencodeClient.mockReset();
  });

  it("builds OpenCode config from prism0 AppConfig", () => {
    expect(buildOpencodeConfig(config)).toEqual({
      model: "openai/gpt-4.1-mini",
      provider: {
        openai: {
          options: {
            apiKey: "k",
            baseURL: "https://example.com/v1",
            timeout: 120_000
          }
        }
      },
      enabled_providers: ["openai"],
      disabled_providers: []
    });
  });

  it("parses provider/model pairs", () => {
    expect(parseOpencodeModel("openai/gpt-4.1-mini")).toEqual({
      providerID: "openai",
      modelID: "gpt-4.1-mini"
    });
    expect(parseOpencodeModel("gpt-4.1-mini")).toEqual({
      providerID: "openai",
      modelID: "gpt-4.1-mini"
    });
  });

  it("orders selected models before configured fallbacks", () => {
    expect(
      getModelCandidates({ ...config, openaiModels: ["primary", "fallback-a", "fallback-b"] }, "fallback-a")
    ).toEqual(["fallback-a", "primary", "fallback-b"]);
  });

  it("aborts OpenCode sessions when signals fire", () => {
    const client = {
      session: { abort: vi.fn().mockRejectedValue(new Error("abort failed")) }
    } as unknown as import("@opencode-ai/sdk/client").OpencodeClient;

    abortOpencodeSession(client, "ses_test");
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "ses_test" } });
  });

  it("finds an available localhost port", async () => {
    const port = await findAvailablePort();
    expect(port).toBeGreaterThan(0);
  });

  it("rejects invalid listen addresses", () => {
    expect(() => resolveListenPort(null)).toThrow(/Failed to resolve an OpenCode server port/);
    expect(() => resolveListenPort("/tmp/socket.sock")).toThrow(/Failed to resolve an OpenCode server port/);
    expect(resolveListenPort({ address: "127.0.0.1", family: "IPv4", port: 4321 })).toBe(4321);
  });

  it("rejects when an ephemeral port cannot be resolved after bind", async () => {
    const close = vi.fn((callback?: () => void) => callback?.());
    const fakeServer = {
      once: vi.fn(),
      listen: vi.fn((_port: number, _host: string, callback?: () => void) => callback?.()),
      close,
      address: () => null
    };

    createServerMock.mockReturnValueOnce(fakeServer as ReturnType<typeof import("node:net").createServer>);

    await expect(findAvailablePort()).rejects.toThrow(/Failed to resolve an OpenCode server port/);
    expect(close).toHaveBeenCalled();
  });

  it("retries OpenCode startup when the first port is busy", async () => {
    createOpencodeServer
      .mockRejectedValueOnce(new Error("port busy"))
      .mockResolvedValueOnce({ url: "http://127.0.0.1:4108", close: vi.fn() });

    const server = await startOpencodeServer(config);
    expect(server.url).toBe("http://127.0.0.1:4108");
    expect(createOpencodeServer).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting OpenCode startup retries", async () => {
    createOpencodeServer.mockRejectedValue(new Error("startup failed"));
    await expect(startOpencodeServer(config)).rejects.toThrow(/startup failed/);
    expect(createOpencodeServer).toHaveBeenCalledTimes(8);
  });

  it("normalizes non-error startup failures", async () => {
    createOpencodeServer.mockRejectedValue("plain startup failure");
    await expect(startOpencodeServer(config)).rejects.toThrow(/plain startup failure/);
  });

  it("prepends the OpenCode binary directory to PATH", () => {
    const env = ensureOpencodeOnPath({ PATH: "/bin" });
    expect(env.PATH).toContain(resolveOpencodeBinDir());
    expect(env.PATH).toContain("/bin");

    expect(ensureOpencodeOnPath({ PATH: `${resolveOpencodeBinDir()}:/bin` })).toEqual({
      PATH: `${resolveOpencodeBinDir()}:/bin`
    });
    expect(ensureOpencodeOnPath({})).toHaveProperty("PATH");

    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const windows = ensureOpencodeOnPath({ Path: "C:\\bin" });
    expect(windows.Path).toContain(resolveOpencodeBinDir());
    platform.mockRestore();
  });

  it("runs prompts through OpenCode sessions and streams chunks", async () => {
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    const content: string[] = [];
    const usage: unknown[] = [];
    const result = await runOpencodePrompt(config, "make app", "generate", {
      onContent: (chunk) => content.push(chunk),
      onStreamOpen: vi.fn(),
      onUsage: (metrics) => usage.push(metrics)
    });

    expect(result).toBe("hello");
    expect(content.join("")).toBe("hello");
    expect(usage[0]).toEqual({
      kind: "generate",
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 2
    });
    expect(client.session.promptAsync).toHaveBeenCalled();
    expect(client.session.delete).toHaveBeenCalled();
  });

  it("ignores unrelated events and handles non-string session errors", async () => {
    const { client, sessionId } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message.part.updated",
            properties: {
              part: { type: "text", sessionID: "other-session" },
              delta: "skip"
            }
          };
          yield {
            type: "message.part.updated",
            properties: {
              part: { type: "text", sessionID: sessionId }
            }
          };
          yield {
            type: "session.error",
            properties: { sessionID: sessionId, error: { code: 500 } }
          };
        }
      }
    });

    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(/"code":500/);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          return;
        }
      }
    });
    client.session.messages.mockResolvedValue({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }]
    });
    await expect(runOpencodePrompt(config, "make app", "generate")).resolves.toBe("done");
  });

  it("falls back across configured models", async () => {
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    client.session.promptAsync
      .mockRejectedValueOnce(new Error("403 status code"))
      .mockResolvedValueOnce(undefined);

    const onModelFallback = vi.fn();
    const result = await runOpencodePrompt(
      { ...config, openaiModels: ["primary", "fallback"] },
      "make app",
      "generate",
      { onModelFallback },
      { selectedModel: "fallback" }
    );

    expect(result).toBe("hello");
    expect(onModelFallback).toHaveBeenCalledWith(
      "fallback",
      expect.stringContaining("Model provider rejected the request (403)"),
      "primary"
    );
  });

  it("runs shell commands through OpenCode", async () => {
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    const logs: string[] = [];
    const output = await runOpencodeShell(config, "npm run lint", "/tmp/project", (line) => logs.push(line));

    expect(output).toBe("lint ok\n");
    expect(logs).toEqual(["lint ok"]);
    expect(client.session.shell).toHaveBeenCalledWith({
      path: { id: "ses_test" },
      query: { directory: "/tmp/project" },
      body: { agent: "build", command: "npm run lint" }
    });
  });

  it("propagates pause and stop abort reasons", async () => {
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        }
      }
    });

    const controller = new AbortController();
    const pending = runOpencodePrompt(config, "make app", "generate", {}, { signal: controller.signal });
    controller.abort("pause");
    await expect(pending).rejects.toThrow(/paused by user/);

    client.session.shell.mockImplementation(() => new Promise(() => {}));
    const stopController = new AbortController();
    const stopPending = runOpencodeShell(config, "npm test", "/tmp", () => {}, stopController.signal);
    stopController.abort("stop");
    await expect(stopPending).rejects.toThrow(/stopped by user/);
  });

  it("normalizes upstream auth failures into actionable messages", async () => {
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);
    client.session.promptAsync.mockRejectedValue(new Error("403 status code (no body)"));

    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(
      /Model provider rejected the request \(403\)/
    );
  });

  it("streams reasoning chunks and handles assistant API errors", async () => {
    const { client, sessionId } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message.part.updated",
            properties: {
              part: { type: "reasoning", sessionID: sessionId },
              delta: "think"
            }
          };
          yield {
            type: "session.idle",
            properties: { sessionID: sessionId }
          };
        }
      }
    });
    client.session.messages.mockResolvedValue({
      data: [
        {
          info: {
            role: "assistant",
            error: { data: { message: "401 unauthorized" } }
          },
          parts: []
        }
      ]
    });

    const reasoning: string[] = [];
    await expect(
      runOpencodePrompt(config, "make app", "generate", {
        onReasoning: (chunk) => reasoning.push(chunk)
      })
    ).rejects.toThrow(/Model provider rejected the request \(401\)/);
    expect(reasoning.join("")).toBe("think");

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session.idle",
            properties: { sessionID: sessionId }
          };
        }
      }
    });
    client.session.messages.mockResolvedValue({
      data: [
        { info: { role: "user" }, parts: [] },
        {
          info: { role: "assistant", error: { name: "APIError", reason: "quota" } },
          parts: []
        }
      ]
    });
    await expect(runOpencodePrompt(config, "make app", "generate", {}, { directory: "/tmp/project" })).rejects.toThrow(
      /quota/
    );

    client.session.messages.mockResolvedValue({ data: undefined });
    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(/empty response/);
  });

  it("throws when sessions, shell output, or model responses are empty", async () => {
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    client.session.create.mockResolvedValueOnce({ data: {} });
    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(
      /failed to create a generation session/
    );

    client.session.create.mockResolvedValueOnce({ data: { id: "ses_test" } });
    client.session.shell.mockResolvedValueOnce({ data: { parts: [] } });
    await expect(runOpencodeShell(config, "npm test", "/tmp", () => {})).rejects.toThrow(
      /no command output/
    );

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session.idle",
            properties: { sessionID: "ses_test" }
          };
        }
      }
    });
    client.session.messages.mockResolvedValue({ data: [{ info: { role: "assistant" }, parts: [] }] });
    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(/empty response/);
  });

  it("reports shell tool errors and reuses cached clients", async () => {
    const close = vi.fn();
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close });
    createOpencodeClient.mockReturnValue(client);

    client.session.shell.mockResolvedValue({
      data: {
        parts: [
          {
            type: "tool",
            state: { status: "error", error: "lint failed" }
          }
        ]
      }
    });

    await expect(runOpencodeShell(config, "npm run lint", "/tmp", () => {})).rejects.toThrow(/lint failed/);

    client.session.create.mockResolvedValueOnce({ data: {} });
    await expect(runOpencodeShell(config, "npm run lint", "/tmp", () => {})).rejects.toThrow(
      /failed to create a validation session/
    );

    const handle = (await import("../src/opencodeService.js")).createOpencodeClientHandle(config);
    await handle.getClient();
    await handle.getClient();
    expect(createOpencodeServer).toHaveBeenCalledTimes(1);

    await shutdownOpencode();
    expect(close).toHaveBeenCalled();
  });

  it("handles session errors, hard limits, and stop aborts during prompts", async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(Date, "now");
    const { client, sessionId } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session.error",
            properties: { sessionID: sessionId, error: "500 backend exploded" }
          };
        }
      }
    });

    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(/500 backend exploded/);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message.part.updated",
            properties: {
              part: { type: "text", sessionID: sessionId },
              delta: "a"
            }
          };
        }
      }
    });

    now.mockReturnValueOnce(0).mockReturnValueOnce(600_001);
    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(/hard limit/i);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        }
      }
    });
    const stopController = new AbortController();
    const stopPending = runOpencodePrompt(config, "make app", "generate", {}, { signal: stopController.signal });
    stopController.abort("stop");
    await expect(stopPending).rejects.toThrow(/stopped by user/);

    vi.useRealTimers();
  });

  it("falls back to assistant text, async prompt errors, and stream timeouts", async () => {
    vi.useFakeTimers();
    const { client, sessionId } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "session.idle",
            properties: { sessionID: sessionId }
          };
        }
      }
    });
    client.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: "assistant", tokens: { input: 1, output: 2, reasoning: 0 } },
          parts: [
            { type: "reasoning", text: "ignored" },
            { type: "text", text: "from-parts" }
          ]
        }
      ]
    });

    await expect(runOpencodePrompt(config, "make app", "generate")).resolves.toBe("from-parts");

    client.session.promptAsync.mockRejectedValueOnce(new Error("prompt blew up"));
    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(/prompt blew up/);

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        }
      }
    });
    const firstChunkPending = runOpencodePrompt(config, "make app", "generate");
    const firstChunkRejection = expect(firstChunkPending).rejects.toThrow(/No response from model within/i);
    await vi.advanceTimersByTimeAsync(120_000);
    await firstChunkRejection;

    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message.part.updated",
            properties: {
              part: { type: "text", sessionID: sessionId },
              delta: "chunk"
            }
          };
          await new Promise(() => {});
        }
      }
    });
    const stallPending = runOpencodePrompt(config, "make app", "generate");
    const stallRejection = expect(stallPending).rejects.toThrow(/Model stream stalled/i);
    await vi.advanceTimersByTimeAsync(60_000);
    await stallRejection;

    const env = ensureOpencodeOnPath({ PATH: `${resolveOpencodeBinDir()}:/bin` });
    expect(env.PATH).toBe(`${resolveOpencodeBinDir()}:/bin`);

    vi.useRealTimers();
  });

  it("resolves binary paths and aborts in-flight prompt streams on pause", async () => {
    expect(resolveOpencodeBinDir(() => false)).toContain("node_modules/.bin");

    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);
    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        }
      }
    });

    const pauseController = new AbortController();
    const pausePending = runOpencodePrompt(config, "make app", "generate", {}, { signal: pauseController.signal });
    setTimeout(() => pauseController.abort("pause"), 10);
    await expect(pausePending).rejects.toThrow(/paused by user/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.session.abort).toHaveBeenCalled();

    const stopController = new AbortController();
    const stopPending = runOpencodePrompt(config, "make app", "generate", {}, { signal: stopController.signal });
    setTimeout(() => stopController.abort("stop"), 10);
    await expect(stopPending).rejects.toThrow(/stopped by user/);
  });

  it("skips PATH assignment on Windows when only Path is configured", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    const originalPath = process.env.PATH;
    const originalPathWin = process.env.Path;
    delete process.env.PATH;
    process.env.Path = `${resolveOpencodeBinDir()};C:\\bin`;

    const handle = (await import("../src/opencodeService.js")).createOpencodeClientHandle(config);
    await handle.getClient();

    expect(process.env.PATH).toBeUndefined();

    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalPathWin === undefined) {
      delete process.env.Path;
    } else {
      process.env.Path = originalPathWin;
    }
    platform.mockRestore();
  });

  it("covers shell edge cases, cleanup failures, and client bootstrap paths", async () => {
    const { client } = createMockClient();
    createOpencodeServer.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClient.mockReturnValue(client);

    client.session.shell.mockResolvedValue({
      data: {
        parts: [
          {
            type: "tool",
            state: { status: "running", input: { command: "npm test" } }
          }
        ]
      }
    });
    await expect(runOpencodeShell(config, "npm test", "/tmp", () => {})).resolves.toBe("");

    client.session.shell.mockResolvedValue({
      data: {
        parts: [
          {
            type: "tool",
            state: { status: "error", error: "" }
          }
        ]
      }
    });
    await expect(runOpencodeShell(config, "npm test", "/tmp", () => {})).rejects.toThrow(
      /OpenCode shell command failed: npm test/
    );

    client.session.shell.mockResolvedValue({ data: undefined });
    await expect(runOpencodeShell(config, "npm test", "/tmp", () => {})).rejects.toThrow(
      /no command output/
    );

    client.session.delete.mockRejectedValue(new Error("cleanup failed"));
    await expect(runOpencodePrompt(config, "make app", "generate")).resolves.toBe("hello");

    client.session.shell.mockResolvedValue({
      data: {
        parts: [
          {
            type: "tool",
            state: { status: "completed", output: "lint ok\n" }
          }
        ]
      }
    });
    await expect(runOpencodeShell(config, "npm run lint", "/tmp", () => {})).resolves.toBe("lint ok\n");

    const originalPath = process.env.PATH;
    await shutdownOpencode();
    delete process.env.PATH;
    delete process.env.Path;
    const handle = (await import("../src/opencodeService.js")).createOpencodeClientHandle(config);
    await handle.getClient();
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    client.session.promptAsync.mockRejectedValueOnce("plain failure");
    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(/plain failure/);

    vi.useFakeTimers();
    const now = vi.spyOn(Date, "now");
    client.event.subscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message.part.updated",
            properties: {
              part: { type: "text", sessionID: "ses_test" },
              delta: "a"
            }
          };
        }
      }
    });
    client.session.abort.mockRejectedValue(new Error("abort failed"));
    now.mockReturnValueOnce(0).mockReturnValueOnce(600_001);
    await expect(runOpencodePrompt(config, "make app", "generate")).rejects.toThrow(/hard limit/i);
    vi.useRealTimers();
  });
});
