import { describe, expect, it } from "vitest";
import {
  buildFixPrompt,
  buildGenerationPrompt,
  buildJsonFixPrompt,
  buildRuntimeFixPrompt
} from "../src/prompts.js";

describe("buildGenerationPrompt", () => {
  it("includes the user idea and JSON requirements", () => {
    const prompt = buildGenerationPrompt("make a todo app");
    expect(prompt).toContain("make a todo app");
    expect(prompt).toContain('"files"');
    expect(prompt).toContain("index.test.js");
    expect(prompt).toContain("no-unused-vars");
    expect(prompt).toContain("JSON formatting rules");
  });
});

describe("buildJsonFixPrompt", () => {
  it("includes parse error and invalid response for retry", () => {
    const prompt = buildJsonFixPrompt(
      "make a todo app",
      "Expected property name or '}' in JSON at position 2",
      "{ bad json }"
    );
    expect(prompt).toContain("make a todo app");
    expect(prompt).toContain("Expected property name");
    expect(prompt).toContain("{ bad json }");
    expect(prompt).toContain("Fix the JSON syntax");
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

describe("buildRuntimeFixPrompt", () => {
  it("includes runtime errors and current project files", () => {
    const project = {
      summary: "counter app",
      files: { "index.js": "throw new Error('boom');" }
    };
    const prompt = buildRuntimeFixPrompt("make counter", project, "ReferenceError: count is not defined");
    expect(prompt).toContain("make counter");
    expect(prompt).toContain("counter app");
    expect(prompt).toContain("ReferenceError: count is not defined");
    expect(prompt).toContain("throw new Error");
    expect(prompt).toContain("runtime crash");
  });
});
