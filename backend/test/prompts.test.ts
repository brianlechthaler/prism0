import { describe, expect, it } from "vitest";
import { buildGenerationPrompt } from "../src/prompts.js";

describe("buildGenerationPrompt", () => {
  it("includes the user idea and JSON requirements", () => {
    const prompt = buildGenerationPrompt("make a todo app");
    expect(prompt).toContain("make a todo app");
    expect(prompt).toContain('"files"');
    expect(prompt).toContain("index.test.js");
  });
});
