import { afterEach, describe, expect, it, vi } from "vitest";
import * as validateModule from "../src/validateProject.js";
import { runFollowUp, runGeneration, runRuntimeRepair, runValidationRepair } from "../src/generator.js";
import { RunStore } from "../src/runStore.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  openaiModels: ["m"],
  modelPickerEnabled: false,
  host: "127.0.0.1",
  port: 8787,
  requestTimeoutMs: 120_000,
  contextWindowTokens: 128_000,
  maxRuns: 100,
  maxActiveRuns: 5,
  generationRateLimitWindowMs: 60_000,
  generationRateLimitMax: 10,
  trustProxy: false
};

const validPayload = {
  summary: "done",
  files: {
    "index.html": "<html></html>",
    "index.js": "export const x = 1;",
    "styles.css": "body {}",
    "index.test.js": "import { x } from './index.js';",
    "package.json": '{"type":"module","scripts":{"test":"vitest run","lint":"eslint ."}}'
  }
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runGeneration", () => {
  it("completes successful runs", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, handlers) => {
        handlers.onStreamOpen?.();
        handlers.onReasoning?.("r".repeat(401));
        handlers.onContent?.("c".repeat(501));
        handlers.onUsage?.({
          kind: "generate",
          promptTokens: 100,
          completionTokens: 30,
          reasoningTokens: 10
        });
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
    expect(final?.usage?.inputTokens).toBe(100);
    expect(final?.usage?.outputTokens).toBe(30);
    expect(final?.usage?.buckets.map((bucket) => bucket.kind)).toEqual(["thinking", "generate"]);
  });

  it("does not log stream milestones before thresholds are reached", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, handlers) => {
        handlers.onReasoning?.("r");
        handlers.onContent?.("c");
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

    const logs = store.get(run.id)?.logs.join("\n") ?? "";
    expect(logs).not.toContain("Model reasoning stream");
    expect(logs).not.toContain("Model content stream");
  });

  it("logs model fallback attempts", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, handlers) => {
        handlers.onModelAttempt?.("single", 1, 1);
        handlers.onModelAttempt?.("fallback", 1, 2);
        handlers.onModelFallback?.("fallback", "model unavailable", "m");
        handlers.onModelAttempt?.("m", 2, 2);
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration({ ...config, openaiModels: ["m", "fallback"] }, store, run.id, run.idea, "fallback");

    const logs = store.get(run.id)?.logs.join("\n") ?? "";
    expect(logs).toContain("Trying model fallback (1/2)");
    expect(logs).toContain("Model fallback failed: model unavailable");
    expect(logs).toContain("Trying fallback m");
    expect(logs).toContain("Trying model m (2/2)");
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

  it("does not log JSON fix milestones before thresholds are reached", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue("{ bad json }");
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, _idea, _invalid, _error, handlers) => {
        handlers?.onContent?.("x");
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

    expect(store.get(run.id)?.logs.join("\n")).not.toContain("Model JSON fix stream");
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

  it("does not log validation fix milestones before thresholds are reached", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        handlers?.onContent?.("x");
        return "{ bad json }";
      }
    );
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, _idea, _invalid, _error, handlers) => {
        handlers?.onContent?.("x");
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

    const logs = store.get(run.id)?.logs.join("\n") ?? "";
    expect(logs).not.toContain("Model fix stream");
    expect(logs).not.toContain("Model JSON fix stream");
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
    expect(final?.files["index.js"]).toContain("export const x = 1");
    expect(llm.fixProjectFromValidationErrors).toHaveBeenCalledTimes(4);
  });

  it("repairs runtime errors and publishes fixed files", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromRuntimeError").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        handlers?.onStreamOpen?.();
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify({
          ...validPayload,
          files: { ...validPayload.files, "index.js": "export const fixed = true;" }
        });
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runRuntimeRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "throw new Error('boom');" } },
      "Error: boom"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(final?.files["index.js"]).toContain("fixed");
    expect(llm.fixProjectFromRuntimeError).toHaveBeenCalledTimes(1);
    expect(final?.logs.some((l) => l.includes("runtime repair"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Runtime repair checks passed"))).toBe(true);
  });

  it("applies follow-up prompts and publishes updated files", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "updateProjectFromFollowUp").mockImplementation(
      async (_config, _idea, _project, _prompt, handlers) => {
        handlers?.onStreamOpen?.();
        handlers?.onContent?.("x".repeat(500));
        handlers?.onUsage?.({
          kind: "follow_up",
          promptTokens: 90,
          completionTokens: 20,
          reasoningTokens: 0
        });
        return JSON.stringify({
          ...validPayload,
          summary: "updated counter",
          files: { ...validPayload.files, "index.js": "export const reset = () => 0;" }
        });
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make counter");
    await runFollowUp(
      config,
      store,
      run.id,
      "make counter",
      { summary: "counter", files: { "index.js": "export const count = 0;" } },
      "add a reset button"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(final?.files["index.js"]).toContain("reset");
    expect(final?.usage?.buckets.map((bucket) => bucket.kind)).toEqual(["follow_up"]);
    expect(final?.logs.some((l) => l.includes("follow-up run"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Model follow-up stream"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Follow-up checks passed"))).toBe(true);
  });

  it("retries JSON parsing when follow-up returns invalid JSON", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "updateProjectFromFollowUp").mockResolvedValue("{ bad json }");
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, idea, _invalid, _error, handlers) => {
        expect(idea).toContain("Follow-up request: add keyboard shortcuts");
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make editor");
    await runFollowUp(
      config,
      store,
      run.id,
      "make editor",
      { summary: "editor", files: { "index.js": "export const value = '';" } },
      "add keyboard shortcuts"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(llm.fixInvalidJsonResponse).toHaveBeenCalledTimes(1);
    expect(final?.logs.some((l) => l.includes("Model JSON fix stream"))).toBe(true);
  });

  it("does not log follow-up JSON fix milestones before thresholds are reached", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "updateProjectFromFollowUp").mockResolvedValue("{ bad json }");
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, _idea, _invalid, _error, handlers) => {
        handlers?.onContent?.("x");
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runFollowUp(
      config,
      store,
      run.id,
      "make app",
      { summary: "app", files: { "index.js": "export const x = 1;" } },
      "add settings"
    );

    const logs = store.get(run.id)?.logs.join("\n") ?? "";
    expect(logs).not.toContain("Model JSON fix stream");
  });

  it("does not log follow-up milestones before thresholds are reached", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "updateProjectFromFollowUp").mockImplementation(
      async (_config, _idea, _project, _prompt, handlers) => {
        handlers?.onContent?.("x");
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runFollowUp(
      config,
      store,
      run.id,
      "make app",
      { summary: "app", files: { "index.js": "export const x = 1;" } },
      "add settings"
    );

    const logs = store.get(run.id)?.logs.join("\n") ?? "";
    expect(logs).not.toContain("Model follow-up stream");
  });

  it("marks follow-up runs failed when the model throws", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "updateProjectFromFollowUp").mockRejectedValue("plain follow-up failure");

    const store = new RunStore();
    const run = store.create("make app");
    await runFollowUp(
      config,
      store,
      run.id,
      "make app",
      { summary: "app", files: { "index.js": "export const x = 1;" } },
      "add settings"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toBe("plain follow-up failure");
    expect(final?.files["index.js"]).toContain("export const x = 1");
    expect(final?.logs.some((l) => l.includes("Follow-up failed"))).toBe(true);
  });

  it("marks follow-up runs failed for Error objects", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "updateProjectFromFollowUp").mockRejectedValue(new Error("follow-up failed"));

    const store = new RunStore();
    const run = store.create("make app");
    await runFollowUp(
      config,
      store,
      run.id,
      "make app",
      { summary: "app", files: { "index.js": "export const x = 1;" } },
      "add settings"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toBe("follow-up failed");
  });

  it("retries JSON parsing when runtime repair returns invalid JSON", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromRuntimeError").mockResolvedValue("{ bad json }");
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
    await runRuntimeRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "throw new Error('boom');" } },
      "Error: boom"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(llm.fixInvalidJsonResponse).toHaveBeenCalledTimes(1);
    expect(final?.logs.some((l) => l.includes("Model JSON fix stream"))).toBe(true);
  });

  it("does not log runtime repair milestones before thresholds are reached", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromRuntimeError").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        handlers?.onContent?.("x");
        return "{ bad json }";
      }
    );
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, _idea, _invalid, _error, handlers) => {
        handlers?.onContent?.("x");
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runRuntimeRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "throw new Error('boom');" } },
      "Error: boom"
    );

    const logs = store.get(run.id)?.logs.join("\n") ?? "";
    expect(logs).not.toContain("Model runtime fix stream");
    expect(logs).not.toContain("Model JSON fix stream");
  });

  it("marks runtime repair failed when the model throws", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromRuntimeError").mockRejectedValue(new Error("repair failed"));

    const store = new RunStore();
    const run = store.create("make app");
    await runRuntimeRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "throw new Error('boom');" } },
      "Error: boom"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toBe("repair failed");
    expect(final?.files["index.js"]).toContain("throw new Error('boom')");
    expect(final?.logs.some((l) => l.includes("Runtime repair failed"))).toBe(true);
  });

  it("handles non-error runtime repair failures", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromRuntimeError").mockRejectedValue("plain repair failure");

    const store = new RunStore();
    const run = store.create("make app");
    await runRuntimeRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "throw new Error('boom');" } },
      "Error: boom"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toBe("plain repair failure");
  });

  it("repairs validation errors and publishes fixed files", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        handlers?.onStreamOpen?.();
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify({
          ...validPayload,
          files: { ...validPayload.files, "index.js": "export const fixed = true;" }
        });
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runValidationRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "export const broken = true;" } },
      "lint still failing"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(final?.files["index.js"]).toContain("fixed");
    expect(final?.logs.some((l) => l.includes("validation repair"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Validation repair checks passed"))).toBe(true);
  });

  it("retries JSON parsing when validation repair returns invalid JSON", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockResolvedValue("{ bad json }");
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
    await runValidationRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "export const broken = true;" } },
      "lint still failing"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(llm.fixInvalidJsonResponse).toHaveBeenCalledTimes(1);
    expect(final?.logs.some((l) => l.includes("Model JSON fix stream"))).toBe(true);
  });

  it("does not log validation repair milestones before thresholds are reached", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        handlers?.onContent?.("x");
        return "{ bad json }";
      }
    );
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, _idea, _invalid, _error, handlers) => {
        handlers?.onContent?.("x");
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runValidationRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "export const broken = true;" } },
      "lint still failing"
    );

    const logs = store.get(run.id)?.logs.join("\n") ?? "";
    expect(logs).not.toContain("Model validation fix stream");
    expect(logs).not.toContain("Model JSON fix stream");
  });

  it("marks validation repair failed when the model throws", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockRejectedValue(new Error("validation repair failed"));

    const store = new RunStore();
    const run = store.create("make app");
    await runValidationRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "export const broken = true;" } },
      "lint still failing"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toBe("validation repair failed");
    expect(final?.files["index.js"]).toContain("export const broken = true");
    expect(final?.logs.some((l) => l.includes("Validation repair failed"))).toBe(true);
  });

  it("handles non-error validation repair failures", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockRejectedValue("plain validation repair failure");

    const store = new RunStore();
    const run = store.create("make app");
    await runValidationRepair(
      config,
      store,
      run.id,
      run.idea,
      { summary: "broken", files: { "index.js": "export const broken = true;" } },
      "lint still failing"
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.error).toBe("plain validation repair failure");
  });
});
