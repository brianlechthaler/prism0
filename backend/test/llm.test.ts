import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: createMock
      }
    }
  }))
}));

import {
  createOpenAiClient,
  fixInvalidJsonResponse,
  fixProjectFromValidationErrors,
  generateProjectFromIdea
} from "../src/llm.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  port: 8787
};

describe("llm", () => {
  beforeEach(() => {
    createMock.mockReset();
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
