import { describe, expect, it } from "vitest";
import {
  buildContextCompressionPrompt,
  buildFixPrompt,
  buildFollowUpPrompt,
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

describe("buildFollowUpPrompt", () => {
  it("includes follow-up instructions and current project files", () => {
    const project = {
      summary: "counter app",
      files: { "index.js": "export const count = 0;" }
    };
    const prompt = buildFollowUpPrompt("make counter", project, "add a reset button");
    expect(prompt).toContain("make counter");
    expect(prompt).toContain("counter app");
    expect(prompt).toContain("add a reset button");
    expect(prompt).toContain("export const count = 0;");
    expect(prompt).toContain("complete updated project, not a diff");
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

  it("includes compressed context and truncates invalid responses when provided", () => {
    const prompt = buildJsonFixPrompt(
      "make a todo app",
      "Unexpected token",
      "x".repeat(5000),
      "Earlier the model built a todo list with add/remove actions."
    );
    expect(prompt).toContain("Compressed run context from earlier steps");
    expect(prompt).toContain("Earlier the model built a todo list");
    expect(prompt).toContain("[truncated 1000 chars]");
    expect(prompt).not.toContain("x".repeat(5000));
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

describe("buildContextCompressionPrompt", () => {
  it("includes run context, logs, and prior summaries", () => {
    const prompt = buildContextCompressionPrompt({
      idea: "make counter",
      project: {
        summary: "counter app",
        files: { "index.js": "export const count = 0;" }
      },
      recentLogs: ["log line one", "log line two"],
      priorSummary: "already compressed once",
      contextUsedPercent: 92.5
    });

    expect(prompt).toContain("make counter");
    expect(prompt).toContain("counter app");
    expect(prompt).toContain("index.js (23 chars)");
    expect(prompt).toContain("log line two");
    expect(prompt).toContain("already compressed once");
    expect(prompt).toContain("92.5% used");
  });

  it("handles missing project files and empty logs", () => {
    const prompt = buildContextCompressionPrompt({
      idea: "make counter",
      recentLogs: [],
      contextUsedPercent: 95
    });

    expect(prompt).toContain("(no project files yet)");
    expect(prompt).toContain("(not generated yet)");
    expect(prompt).toContain("(none)");
  });
});

describe("buildJsonFixPrompt without compressed context", () => {
  it("includes the full invalid response when no summary exists", () => {
    const invalid = "short invalid json";
    const prompt = buildJsonFixPrompt("make app", "bad json", invalid);
    expect(prompt).toContain(invalid);
    expect(prompt).not.toContain("[truncated");
  });

  it("keeps short invalid responses when compressed context is present", () => {
    const invalid = "short invalid json";
    const prompt = buildJsonFixPrompt("make app", "bad json", invalid, "Earlier summary.");
    expect(prompt).toContain(invalid);
    expect(prompt).not.toContain("[truncated");
  });
});
