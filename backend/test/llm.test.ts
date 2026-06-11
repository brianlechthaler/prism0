import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => {
  const MockOpenAI = vi.fn(function MockOpenAI() {
    return {
      chat: {
        completions: {
          create: createMock
        }
      }
    };
  });

  return { default: MockOpenAI };
});

import {
  compressRunContextWithModel,
  createOpenAiClient,
  fixInvalidJsonResponse,
  fixProjectFromRuntimeError,
  fixProjectFromValidationErrors,
  generateProjectFromIdea,
  getModelCandidates,
  updateProjectFromFollowUp
} from "../src/llm.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  openaiModels: ["m"],
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

describe("llm", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates an OpenAI client", () => {
    const client = createOpenAiClient(config);
    expect(client.chat.completions.create).toBeTypeOf("function");
  });

  it("orders selected models before configured fallbacks", () => {
    expect(
      getModelCandidates({ ...config, openaiModels: ["primary", "fallback-a", "fallback-b"] }, "fallback-a")
    ).toEqual(["fallback-a", "primary", "fallback-b"]);
  });

  it("streams content and returns full response", async () => {
    async function* mockStream() {
      yield {
        choices: [{ delta: { reasoning_content: "thinking", content: "hel" } }]
      };
      yield {
        choices: [{ delta: { content: "lo" } }]
      };
    }
    createMock.mockResolvedValue(mockStream());

    const reasoning: string[] = [];
    const content: string[] = [];

    const result = await generateProjectFromIdea(config, "make app", {
      onReasoning: (c) => reasoning.push(c),
      onContent: (c) => content.push(c)
    });

    expect(result).toBe("hello");
    expect(reasoning.join("")).toBe("thinking");
    expect(content.join("")).toBe("hello");
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    });
  });

  it("falls back to the next configured model when the selected model fails", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }

    createMock.mockRejectedValueOnce(new Error("selected unavailable")).mockResolvedValueOnce(mockStream());
    const onModelFallback = vi.fn();

    const result = await generateProjectFromIdea(
      { ...config, openaiModels: ["primary", "fallback"] },
      "make app",
      { onModelFallback },
      { selectedModel: "fallback" }
    );

    expect(result).toBe("ok");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]?.[0]?.model).toBe("fallback");
    expect(createMock.mock.calls[1]?.[0]?.model).toBe("primary");
    expect(onModelFallback).toHaveBeenCalledWith("fallback", "selected unavailable", "primary");
  });

  it("reports non-error fallback failures as strings", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }

    createMock.mockRejectedValueOnce("plain failure").mockResolvedValueOnce(mockStream());
    const onModelFallback = vi.fn();

    await generateProjectFromIdea(
      { ...config, openaiModels: ["primary", "fallback"] },
      "make app",
      { onModelFallback },
      { selectedModel: "fallback" }
    );

    expect(onModelFallback).toHaveBeenCalledWith("fallback", "plain failure", "primary");
  });

  it("reports final stream usage with reasoning token details", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: "hello" } }] };
      yield {
        choices: [],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          completion_tokens_details: { reasoning_tokens: 12 }
        }
      };
    }
    createMock.mockResolvedValue(mockStream());

    const onUsage = vi.fn();
    await generateProjectFromIdea(config, "make app", { onUsage });

    expect(onUsage).toHaveBeenCalledWith({
      kind: "generate",
      promptTokens: 123,
      completionTokens: 45,
      reasoningTokens: 12
    });
  });

  it("defaults missing usage fields to zero", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: "fixed" } }] };
      yield { choices: [], usage: {} };
    }
    createMock.mockResolvedValue(mockStream());

    const onUsage = vi.fn();
    await fixInvalidJsonResponse(config, "idea", "{ bad }", "parse error", { onUsage });

    expect(onUsage).toHaveBeenCalledWith({
      kind: "json_fix",
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0
    });
  });

  it("calls onStreamOpen when the stream is created", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    createMock.mockResolvedValue(mockStream());

    const onStreamOpen = vi.fn();
    await generateProjectFromIdea(config, "make app", { onStreamOpen });
    expect(onStreamOpen).toHaveBeenCalledTimes(1);
  });

  it("times out when the model stalls between chunks", async () => {
    vi.useFakeTimers();

    createMock.mockResolvedValue({
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next() {
            if (!sent) {
              sent = true;
              return Promise.resolve({
                done: false,
                value: { choices: [{ delta: { content: "a" } }] }
              });
            }
            return new Promise(() => {});
          }
        };
      }
    });

    const pending = generateProjectFromIdea(config, "make app");
    const rejection = expect(pending).rejects.toThrow(/Model stream stalled/i);

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

  });

  it("times out when the API never opens a stream", async () => {
    vi.useFakeTimers();

    createMock.mockReturnValue(new Promise(() => {}));

    const pending = generateProjectFromIdea(config, "make app");
    const rejection = expect(pending).rejects.toThrow(/Model API request timed out/i);

    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;

  });

  it("times out when the model never sends a first chunk", async () => {
    vi.useFakeTimers();

    createMock.mockResolvedValue({
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise(() => {});
          }
        };
      }
    });

    const pending = generateProjectFromIdea(config, "make app");
    const rejection = expect(pending).rejects.toThrow(/No response from model within/i);

    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;

  });

  it("enforces a hard stream time limit", async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(Date, "now");

    createMock.mockResolvedValue({
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.resolve({
              done: false,
              value: { choices: [{ delta: { content: "a" } }] }
            });
          }
        };
      }
    });

    const pending = generateProjectFromIdea(config, "make app");
    const rejection = expect(pending).rejects.toThrow(/hard limit/i);

    now.mockReturnValueOnce(0).mockReturnValueOnce(600_001);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;

  });

  it("throws on empty model response", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: {} }] };
    }
    createMock.mockResolvedValue(mockStream());

    await expect(generateProjectFromIdea(config, "idea")).rejects.toThrow(/empty response/i);
  });

  it("requests fixes using validation error context", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: '{"summary":"fixed","files":{}}' } }] };
    }
    createMock.mockResolvedValue(mockStream());

    const result = await fixProjectFromValidationErrors(
      config,
      "make tetris",
      { summary: "broken tetris", files: { "index.js": "const x = 1;" } },
      "lint failed"
    );

    expect(result).toContain("fixed");
    const prompt = createMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(prompt).toContain("make tetris");
    expect(prompt).toContain("lint failed");
  });

  it("requests follow-up updates using existing project context", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: '{"summary":"updated","files":{}}' } }] };
    }
    createMock.mockResolvedValue(mockStream());

    const result = await updateProjectFromFollowUp(
      config,
      "make counter",
      { summary: "counter app", files: { "index.js": "export const count = 0;" } },
      "add a reset button"
    );

    expect(result).toContain("updated");
    const prompt = createMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(prompt).toContain("make counter");
    expect(prompt).toContain("add a reset button");
    expect(prompt).toContain("export const count = 0;");
  });

  it("requests fixes using runtime error context", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: '{"summary":"fixed","files":{}}' } }] };
    }
    createMock.mockResolvedValue(mockStream());

    const result = await fixProjectFromRuntimeError(
      config,
      "make counter",
      { summary: "broken counter", files: { "index.js": "throw new Error('boom');" } },
      "ReferenceError: count is not defined"
    );

    expect(result).toContain("fixed");
    const prompt = createMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(prompt).toContain("make counter");
    expect(prompt).toContain("ReferenceError: count is not defined");
    expect(prompt).toContain("runtime crash");
  });

  it("requests JSON fixes using parse error context", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: '{"summary":"fixed","files":{}}' } }] };
    }
    createMock.mockResolvedValue(mockStream());

    const result = await fixInvalidJsonResponse(
      config,
      "make tetris",
      "{ bad json }",
      "Expected property name or '}' in JSON at position 2"
    );

    expect(result).toContain("fixed");
    const prompt = createMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(prompt).toContain("make tetris");
    expect(prompt).toContain("Expected property name");
    expect(prompt).toContain("{ bad json }");
  });

  it("requests JSON fixes with compressed context and truncated invalid responses", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: '{"summary":"fixed","files":{}}' } }] };
    }
    createMock.mockResolvedValue(mockStream());

    const result = await fixInvalidJsonResponse(
      config,
      "make tetris",
      "x".repeat(5000),
      "Unexpected token",
      {},
      { contextSummary: "Earlier work on a tetris board." }
    );

    expect(result).toContain("fixed");
    const prompt = createMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(prompt).toContain("Earlier work on a tetris board.");
    expect(prompt).toContain("[truncated 1000 chars]");
  });

  it("requests context compression summaries", async () => {
    async function* mockStream() {
      yield { choices: [{ delta: { content: '{"summary":"compressed"}' } }] };
    }
    createMock.mockResolvedValue(mockStream());

    const result = await compressRunContextWithModel(config, "summarize this run", {}, { selectedModel: "m" });

    expect(result).toContain("compressed");
    expect(createMock.mock.calls[0]?.[0]?.model).toBe("m");
  });
});
