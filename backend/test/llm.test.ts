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

import { createOpenAiClient, generateProjectFromIdea } from "../src/llm.js";

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
});
