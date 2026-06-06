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
  createOpenAiClient,
  fixInvalidJsonResponse,
  fixProjectFromRuntimeError,
  fixProjectFromValidationErrors,
  generateProjectFromIdea
} from "../src/llm.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  host: "127.0.0.1",
  port: 8787,
  requestTimeoutMs: 120_000,
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
});
