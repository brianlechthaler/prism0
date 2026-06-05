import { describe, expect, it } from "vitest";
import { buildFixPrompt, buildGenerationPrompt } from "../src/prompts.js";

describe("buildGenerationPrompt", () => {
  it("includes the user idea and JSON requirements", () => {
    const prompt = buildGenerationPrompt("make a todo app");
    expect(prompt).toContain("make a todo app");
    expect(prompt).toContain('"files"');
    expect(prompt).toContain("index.test.js");
    expect(prompt).toContain("no-unused-vars");
  });
});

describe("buildFixPrompt", () => {
  it("includes validation errors and current project files", () => {
    const project = {
      summary: "tetris game",
      files: { "index.js": "export const x = 1;" }
    };
    const prompt = buildFixPrompt("make tetris", project, "lint failed: unused var");
    expect(prompt).toContain("make tetris");
    expect(prompt).toContain("tetris game");
    expect(prompt).toContain("lint failed: unused var");
    expect(prompt).toContain("export const x = 1;");
    expect(prompt).toContain("no-unused-vars");
  });
});
