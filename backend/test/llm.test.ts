import { afterEach, describe, expect, it, vi } from "vitest";

const { runOpencodePrompt } = vi.hoisted(() => ({
  runOpencodePrompt: vi.fn()
}));

vi.mock("../src/opencodeService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/opencodeService.js")>(
    "../src/opencodeService.js"
  );
  return {
    ...actual,
    runOpencodePrompt
  };
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
  afterEach(() => {
    vi.restoreAllMocks();
    runOpencodePrompt.mockReset();
  });

  it("creates an OpenCode client handle", () => {
    const client = createOpenAiClient(config);
    expect(client.getClient).toBeTypeOf("function");
  });

  it("orders selected models before configured fallbacks", () => {
    expect(
      getModelCandidates({ ...config, openaiModels: ["primary", "fallback-a", "fallback-b"] }, "fallback-a")
    ).toEqual(["fallback-a", "primary", "fallback-b"]);
  });

  it("streams content and returns full response", async () => {
    runOpencodePrompt.mockImplementation(async (_config, _prompt, _kind, handlers) => {
      handlers.onReasoning?.("thinking");
      handlers.onContent?.("hel");
      handlers.onContent?.("lo");
      return "hello";
    });

    const reasoning: string[] = [];
    const content: string[] = [];

    const result = await generateProjectFromIdea(config, "make app", {
      onReasoning: (c) => reasoning.push(c),
      onContent: (c) => content.push(c)
    });

    expect(result).toBe("hello");
    expect(reasoning.join("")).toBe("thinking");
    expect(content.join("")).toBe("hello");
    expect(runOpencodePrompt).toHaveBeenCalledWith(
      config,
      expect.stringContaining("make app"),
      "generate",
      expect.any(Object),
      {}
    );
  });

  it("falls back to the next configured model when the selected model fails", async () => {
    const onModelFallback = vi.fn();
    runOpencodePrompt.mockImplementation(async (_config, _prompt, _kind, handlers, options) => {
      handlers.onModelAttempt?.(options?.selectedModel ?? "m", 1, 2);
      if (options?.selectedModel === "fallback") {
        handlers.onModelFallback?.("fallback", "selected unavailable", "primary");
        throw new Error("selected unavailable");
      }
      return "ok";
    });

    await expect(
      generateProjectFromIdea(
        { ...config, openaiModels: ["primary", "fallback"] },
        "make app",
        { onModelFallback },
        { selectedModel: "fallback" }
      )
    ).rejects.toThrow(/selected unavailable/);
  });

  it("reports non-error fallback failures as strings", async () => {
    runOpencodePrompt.mockRejectedValue("plain failure");
    await expect(generateProjectFromIdea(config, "make app")).rejects.toBe("plain failure");
  });

  it("surfaces upstream auth failures from OpenCode", async () => {
    runOpencodePrompt.mockRejectedValue(
      new Error("Model provider rejected the request (403). Check OPENAI_API_KEY, OPENAI_BASE_URL, and model access permissions.")
    );

    await expect(generateProjectFromIdea(config, "make app")).rejects.toThrow(
      /Model provider rejected the request \(403\)/
    );
  });

  it("preserves non-auth upstream status-code errors", async () => {
    runOpencodePrompt.mockRejectedValue(new Error("500 status code (no body)"));

    await expect(generateProjectFromIdea(config, "make app")).rejects.toThrow(
      /500 status code \(no body\)/
    );
  });

  it("reports final stream usage with reasoning token details", async () => {
    runOpencodePrompt.mockImplementation(async (_config, _prompt, _kind, handlers) => {
      handlers.onUsage?.({
        kind: "generate",
        promptTokens: 123,
        completionTokens: 45,
        reasoningTokens: 12
      });
      return "hello";
    });

    const onUsage = vi.fn();
    await generateProjectFromIdea(config, "make app", { onUsage });

    expect(onUsage).toHaveBeenCalledWith({
      kind: "generate",
      promptTokens: 123,
      completionTokens: 45,
      reasoningTokens: 12
    });
  });

  it("calls onStreamOpen when the stream is created", async () => {
    runOpencodePrompt.mockImplementation(async (_config, _prompt, _kind, handlers) => {
      handlers.onStreamOpen?.();
      return "ok";
    });

    const onStreamOpen = vi.fn();
    await generateProjectFromIdea(config, "make app", { onStreamOpen });
    expect(onStreamOpen).toHaveBeenCalledTimes(1);
  });

  it("requests fixes using validation error context", async () => {
    runOpencodePrompt.mockResolvedValue('{"summary":"fixed","files":{}}');

    const result = await fixProjectFromValidationErrors(
      config,
      "make tetris",
      { summary: "broken tetris", files: { "index.js": "const x = 1;" } },
      "lint failed"
    );

    expect(result).toContain("fixed");
    const prompt = runOpencodePrompt.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("make tetris");
    expect(prompt).toContain("lint failed");
  });

  it("requests follow-up updates using existing project context", async () => {
    runOpencodePrompt.mockResolvedValue('{"summary":"updated","files":{}}');

    const result = await updateProjectFromFollowUp(
      config,
      "make counter",
      { summary: "counter app", files: { "index.js": "export const count = 0;" } },
      "add a reset button"
    );

    expect(result).toContain("updated");
    const prompt = runOpencodePrompt.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("make counter");
    expect(prompt).toContain("add a reset button");
    expect(prompt).toContain("export const count = 0;");
  });

  it("requests fixes using runtime error context", async () => {
    runOpencodePrompt.mockResolvedValue('{"summary":"fixed","files":{}}');

    const result = await fixProjectFromRuntimeError(
      config,
      "make counter",
      { summary: "broken counter", files: { "index.js": "throw new Error('boom');" } },
      "ReferenceError: count is not defined"
    );

    expect(result).toContain("fixed");
    const prompt = runOpencodePrompt.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("make counter");
    expect(prompt).toContain("ReferenceError: count is not defined");
    expect(prompt).toContain("runtime crash");
  });

  it("requests JSON fixes using parse error context", async () => {
    runOpencodePrompt.mockResolvedValue('{"summary":"fixed","files":{}}');

    const result = await fixInvalidJsonResponse(
      config,
      "make tetris",
      "{ bad json }",
      "Expected property name or '}' in JSON at position 2"
    );

    expect(result).toContain("fixed");
    const prompt = runOpencodePrompt.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("make tetris");
    expect(prompt).toContain("Expected property name");
    expect(prompt).toContain("{ bad json }");
  });

  it("requests JSON fixes with compressed context and truncated invalid responses", async () => {
    runOpencodePrompt.mockResolvedValue('{"summary":"fixed","files":{}}');

    const result = await fixInvalidJsonResponse(
      config,
      "make tetris",
      "x".repeat(5000),
      "Unexpected token",
      {},
      { contextSummary: "Earlier work on a tetris board." }
    );

    expect(result).toContain("fixed");
    const prompt = runOpencodePrompt.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("Earlier work on a tetris board.");
    expect(prompt).toContain("[truncated 1000 chars]");
  });

  it("requests context compression summaries", async () => {
    runOpencodePrompt.mockResolvedValue('{"summary":"compressed"}');

    const result = await compressRunContextWithModel(config, "summarize this run", {}, { selectedModel: "m" });

    expect(result).toContain("compressed");
    expect(runOpencodePrompt.mock.calls[0]?.[4]).toMatchObject({ selectedModel: "m" });
  });

  it("aborts streaming when the request signal is triggered", async () => {
    runOpencodePrompt.mockRejectedValue(new Error("Generation stopped by user"));

    const controller = new AbortController();
    const pending = generateProjectFromIdea(config, "make app", {}, { signal: controller.signal });
    controller.abort("stop");
    await expect(pending).rejects.toThrow(/stopped by user/);
  });
});
