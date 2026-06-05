import { describe, expect, it, vi } from "vitest";
import * as validateModule from "../src/validateProject.js";
import { runGeneration } from "../src/generator.js";
import { RunStore } from "../src/runStore.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  port: 8787,
  requestTimeoutMs: 120_000
};

const validPayload = {
  summary: "done",
  files: {
    "index.html": "<html></html>",
    "index.js": "export const x = 1;",
    "styles.css": "body {}",
    "index.test.js": "import { x } from './index.js';",
    "package.json": "{}"
  }
};

describe("runGeneration", () => {
  it("completes successful runs", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, handlers) => {
        handlers.onStreamOpen?.();
        handlers.onReasoning?.("r".repeat(401));
        handlers.onContent?.("c".repeat(501));
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockImplementation(
      async (_runId, _files, onLog) => {
        onLog("validated step");
        return { lintOutput: "ok", testOutput: "ok" };
      }
    );

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(final?.files["index.html"]).toContain("<html>");
    expect(final?.logs.some((l) => l.includes("Model stream connected"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Model reasoning stream"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Model content stream"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("validated step"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("All checks passed"))).toBe(true);
  });

  it("logs heartbeat messages while waiting for the model", async () => {
    vi.useFakeTimers();
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      (_config, _idea, handlers) =>
        new Promise((resolve) => {
          setTimeout(() => {
            handlers.onContent?.("ready");
            resolve(JSON.stringify(validPayload));
          }, 30_000);
        })
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    const pending = runGeneration(config, store, run.id, run.idea);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.get(run.id)?.logs.some((l) => l.includes("Still waiting for model response"))).toBe(
      true
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await pending;

    vi.useRealTimers();
  });

  it("skips heartbeat logs after stream activity begins", async () => {
    vi.useFakeTimers();
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      (_config, _idea, handlers) =>
        new Promise((resolve) => {
          handlers.onContent?.("started");
          setTimeout(() => resolve(JSON.stringify(validPayload)), 30_000);
        })
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    const pending = runGeneration(config, store, run.id, run.idea);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.get(run.id)?.logs.some((l) => l.includes("Still waiting for model response"))).toBe(
      false
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await pending;

    vi.useRealTimers();
  });

  it("marks run failed for non-error throwables", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockRejectedValue("plain");

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    expect(store.get(run.id)?.error).toBe("plain");
  });

  it("marks run failed when generation throws", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockRejectedValue(
      new Error("api down")
    );

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toContain("api down");
  });

  it("retries JSON parsing with model fixes until payload is valid", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue("{ bad json }");
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, _idea, _invalid, _error, handlers) => {
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(llm.fixInvalidJsonResponse).toHaveBeenCalledTimes(1);
    expect(final?.logs.some((l) => l.includes("JSON parse attempt 1/"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Model JSON fix stream"))).toBe(true);
  });

  it("fails after exhausting JSON parse retries", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue("{ bad json }");
    vi.spyOn(llm, "fixInvalidJsonResponse").mockResolvedValue("{ still bad }");

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toContain("Failed to parse generated project JSON");
    expect(llm.fixInvalidJsonResponse).toHaveBeenCalledTimes(2);
  });

  it("handles non-error JSON parse failures during retries", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue("{ bad json }");
    vi.spyOn(llm, "fixInvalidJsonResponse").mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const parseSpy = vi.spyOn(await import("../src/parseGenerated.js"), "parseGeneratedResponse");
    parseSpy.mockImplementationOnce(() => {
      throw "bad parse";
    });
    parseSpy.mockImplementation((raw) => JSON.parse(raw));

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    expect(store.get(run.id)?.status).toBe("done");
    expect(store.get(run.id)?.logs.some((l) => l.includes("Parse error: bad parse"))).toBe(true);
    parseSpy.mockRestore();
  });

  it("retries JSON parsing when validation fix returns invalid JSON", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockResolvedValue("{ bad json }");
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, _idea, _invalid, _error, handlers) => {
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify(validPayload);
      }
    );

    let validationCalls = 0;
    vi.spyOn(validateModule, "validateGeneratedProject").mockImplementation(async () => {
      validationCalls += 1;
      if (validationCalls === 1) {
        throw new Error("lint failed: unused var");
      }
      return { lintOutput: "ok", testOutput: "ok" };
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(llm.fixInvalidJsonResponse).toHaveBeenCalledTimes(1);
    expect(final?.logs.some((l) => l.includes("Model JSON fix stream"))).toBe(true);
  });

  it("retries validation with model fixes until checks pass", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify(validPayload);
      }
    );

    let validationCalls = 0;
    vi.spyOn(validateModule, "validateGeneratedProject").mockImplementation(async () => {
      validationCalls += 1;
      if (validationCalls === 1) {
        throw new Error("lint failed: unused var");
      }
      return { lintOutput: "ok", testOutput: "ok" };
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(llm.fixProjectFromValidationErrors).toHaveBeenCalledTimes(1);
    expect(validationCalls).toBe(2);
    expect(final?.logs.some((l) => l.includes("Validation attempt 1/"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Re-running validation (attempt 2/"))).toBe(true);
  });

  it("handles non-error validation failures during retries", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify(validPayload);
      }
    );

    let validationCalls = 0;
    vi.spyOn(validateModule, "validateGeneratedProject").mockImplementation(async () => {
      validationCalls += 1;
      if (validationCalls === 1) {
        throw "lint failed";
      }
      return { lintOutput: "ok", testOutput: "ok" };
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    expect(store.get(run.id)?.status).toBe("done");
    expect(store.get(run.id)?.logs.some((l) => l.includes("Validation error: lint failed"))).toBe(
      true
    );
  });

  it("fails after exhausting validation retries", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockRejectedValue(
      new Error("lint still failing")
    );

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toContain("lint still failing");
    expect(llm.fixProjectFromValidationErrors).toHaveBeenCalledTimes(4);
  });
});
