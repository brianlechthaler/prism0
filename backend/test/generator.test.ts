import { afterEach, describe, expect, it, vi } from "vitest";
import * as validateModule from "../src/validateProject.js";
import {
  resumeRun,
  runFollowUp,
  runGeneration,
  runRuntimeRepair,
  runValidationRepair
} from "../src/generator.js";
import { waitForAbort } from "../src/runControl.js";
import { RunStore } from "../src/runStore.js";

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
    expect(final?.summary).toBe("done");
    expect(final?.files["index.html"]).toContain("<html>");
    expect(final?.logs.some((l) => l.includes("Model stream connected"))).toBe(true);
    expect(final?.streams.thinking).toBe("r".repeat(401));
    expect(final?.streams.content).toContain("c".repeat(501));
    expect(final?.logs.some((l) => l.includes("[validation] validated step"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("All checks passed"))).toBe(true);
    expect(final?.usage?.inputTokens).toBe(100);
    expect(final?.usage?.outputTokens).toBe(30);
    expect(final?.usage?.buckets.map((bucket) => bucket.kind)).toEqual(["thinking", "generate"]);
  });

  it("invokes completion and failure hooks", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, handlers) => {
        handlers.onUsage?.({
          kind: "generate",
          promptTokens: 5,
          completionTokens: 2,
          reasoningTokens: 0
        });
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("hooked app");
    const onComplete = vi.fn();
    await runGeneration(config, store, run.id, run.idea, undefined, {
      hooks: { onComplete, onFail: vi.fn() }
    });
    expect(onComplete).toHaveBeenCalledWith(run.id, expect.objectContaining({ inputTokens: 5 }));

    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockRejectedValue(new Error("boom"));
    const failRun = store.create("hooked fail");
    const onFail = vi.fn();
    await runGeneration(config, store, failRun.id, failRun.idea, undefined, {
      hooks: { onComplete: vi.fn(), onFail }
    });
    expect(onFail).toHaveBeenCalledWith(failRun.id, expect.any(Object));
  });

  it("passes tracker usage to hooks when the store has no usage snapshot", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("tracker usage");
    const onComplete = vi.fn();
    await runGeneration(config, store, run.id, run.idea, undefined, {
      hooks: { onComplete, onFail: vi.fn() }
    });
    expect(onComplete).toHaveBeenCalledWith(run.id, expect.objectContaining({ inputTokens: 0 }));
  });

  it("skips validation when YOLO mode is requested", async () => {
    const validateSpy = vi.spyOn(validateModule, "validateGeneratedProject");
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockResolvedValue(
      JSON.stringify(validPayload)
    );

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea, undefined, { skipValidation: true });

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(validateSpy).not.toHaveBeenCalled();
    expect(final?.logs.some((l) => l.includes("YOLO mode: skipping validation harness"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Skipping validation (YOLO mode)"))).toBe(true);
  });

  it("streams LLM thinking and content chunks to the run store", async () => {
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

    const final = store.get(run.id);
    expect(final?.streams.thinking).toBe("r");
    expect(final?.streams.content).toContain("c");
    expect(final?.streams.content).toContain("=== index.html ===");
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
    expect(final?.streams.content).toContain("x".repeat(500));
  });

  it("compresses run context before JSON fixes when usage nears the limit", async () => {
    const llm = await import("../src/llm.js");
    const compressionConfig = {
      ...config,
      contextWindowTokens: 100,
      contextCompressThreshold: 0.9
    };

    vi.spyOn(llm, "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, handlers) => {
        handlers.onUsage?.({
          kind: "generate",
          promptTokens: 80,
          completionTokens: 12,
          reasoningTokens: 0
        });
        return "{ bad json }";
      }
    );
    vi.spyOn(llm, "compressRunContextWithModel").mockResolvedValue(
      JSON.stringify({ summary: "Built a todo app with add/remove actions." })
    );
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, idea, _invalid, _error, handlers, options) => {
        expect(idea).toContain("Prior run context (compressed):");
        expect(options?.contextSummary).toBe("Built a todo app with add/remove actions.");
        handlers?.onUsage?.({
          kind: "json_fix",
          promptTokens: 10,
          completionTokens: 5,
          reasoningTokens: 0
        });
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(compressionConfig, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(llm.compressRunContextWithModel).toHaveBeenCalledTimes(1);
    expect(final?.logs.some((l) => l.includes("compressing run context"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("usage counter reset"))).toBe(true);
    expect(final?.usage?.totalTokens).toBe(15);
    expect(final?.usage?.buckets.map((bucket) => bucket.kind)).toEqual(["json_fix"]);
  });

  it("handles stream open callbacks without open messages during JSON fixes", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue("{ bad json }");
    vi.spyOn(llm, "fixInvalidJsonResponse").mockImplementation(
      async (_config, _idea, _invalid, _error, handlers) => {
        handlers?.onStreamOpen?.();
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

    expect(store.get(run.id)?.status).toBe("done");
  });

  it("streams JSON fix content even for small responses", async () => {
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

    expect(store.get(run.id)?.streams.content).toContain("x");
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
    expect(final?.streams.content).toContain("x".repeat(500));
  });

  it("streams validation fix content even for small responses", async () => {
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

    const final = store.get(run.id);
    expect(final?.streams.content).toContain("x");
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

  it("retries validation after a transient fix failure", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue(JSON.stringify(validPayload));
    let fixCalls = 0;
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockImplementation(
      async (_config, _idea, _project, _error, handlers) => {
        fixCalls += 1;
        if (fixCalls === 1) {
          throw new Error("transient model error");
        }
        handlers?.onContent?.("x".repeat(500));
        return JSON.stringify(validPayload);
      }
    );

    let validationCalls = 0;
    vi.spyOn(validateModule, "validateGeneratedProject").mockImplementation(async () => {
      validationCalls += 1;
      if (validationCalls <= 2) {
        throw new Error("lint failed");
      }
      return { lintOutput: "ok", testOutput: "ok" };
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(fixCalls).toBe(2);
    expect(validationCalls).toBe(3);
    expect(final?.logs.some((l) => l.includes("Validation fix attempt 1/"))).toBe(true);
    expect(final?.logs.some((l) => l.includes("Retrying validation with another fix attempt"))).toBe(
      true
    );
  });

  it("handles non-error validation fix failures during retries", async () => {
    const llm = await import("../src/llm.js");
    vi.spyOn(llm, "generateProjectFromIdea").mockResolvedValue(JSON.stringify(validPayload));
    let fixCalls = 0;
    vi.spyOn(llm, "fixProjectFromValidationErrors").mockImplementation(async () => {
      fixCalls += 1;
      if (fixCalls === 1) {
        throw "plain fix failure";
      }
      return JSON.stringify(validPayload);
    });

    let validationCalls = 0;
    vi.spyOn(validateModule, "validateGeneratedProject").mockImplementation(async () => {
      validationCalls += 1;
      if (validationCalls <= 2) {
        throw new Error("lint failed");
      }
      return { lintOutput: "ok", testOutput: "ok" };
    });

    const store = new RunStore();
    const run = store.create("make app");
    await runGeneration(config, store, run.id, run.idea);

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(final?.logs.some((l) => l.includes("Validation fix attempt 1/5 failed: plain fix failure"))).toBe(
      true
    );
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
    expect(final?.summary).toBe("updated counter");
    expect(final?.files["index.js"]).toContain("reset");
    expect(final?.usage?.buckets.map((bucket) => bucket.kind)).toEqual(["follow_up"]);
    expect(final?.logs.some((l) => l.includes("follow-up run"))).toBe(true);
    expect(final?.streams.content).toContain("x".repeat(500));
    expect(final?.logs.some((l) => l.includes("Follow-up checks passed"))).toBe(true);
  });

  it("skips validation on follow-up when YOLO mode is requested", async () => {
    const validateSpy = vi.spyOn(validateModule, "validateGeneratedProject");
    vi.spyOn(await import("../src/llm.js"), "updateProjectFromFollowUp").mockResolvedValue(
      JSON.stringify(validPayload)
    );

    const store = new RunStore();
    const run = store.create("make counter");
    await runFollowUp(
      config,
      store,
      run.id,
      "make counter",
      { summary: "counter", files: { "index.js": "export const count = 0;" } },
      "add a reset button",
      undefined,
      { skipValidation: true }
    );

    const final = store.get(run.id);
    expect(final?.status).toBe("done");
    expect(validateSpy).not.toHaveBeenCalled();
    expect(
      final?.logs.some((l) => l.includes("YOLO mode enabled for this follow-up"))
    ).toBe(true);
    expect(final?.logs.some((l) => l.includes("Follow-up validation skipped (YOLO mode)"))).toBe(
      true
    );
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
    expect(final?.streams.content).toContain("x".repeat(500));
  });

  it("streams follow-up JSON fix content even for small responses", async () => {
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

    expect(store.get(run.id)?.streams.content).toContain("x");
  });

  it("streams follow-up content even for small responses", async () => {
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

    expect(store.get(run.id)?.streams.content).toContain("x");
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
    expect(final?.streams.content).toContain("x".repeat(500));
  });

  it("streams runtime repair content even for small responses", async () => {
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

    expect(store.get(run.id)?.streams.content).toContain("x");
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
    expect(final?.streams.content).toContain("x".repeat(500));
  });

  it("streams validation repair content even for small responses", async () => {
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

    expect(store.get(run.id)?.streams.content).toContain("x");
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

describe("run control", () => {
  it("stops generation when the run is aborted", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, _handlers, options) => {
        await waitForAbort(options?.signal);
        return JSON.stringify(validPayload);
      }
    );

    const store = new RunStore();
    const run = store.create("make app");
    store.attachAbortController(run.id);
    const pending = runGeneration(config, store, run.id, run.idea);
    store.stop(run.id);
    await pending;

    expect(store.get(run.id)?.status).toBe("cancelled");
    expect(store.get(run.id)?.logs.some((l) => l.includes("stopped by user"))).toBe(true);
  });

  it("pauses generation while retaining a checkpoint", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, handlers, options) => {
        handlers.onContent?.('{"summary":"partial"');
        await waitForAbort(options?.signal);
        return JSON.stringify(validPayload);
      }
    );

    const store = new RunStore();
    const run = store.create("make app");
    store.attachAbortController(run.id);
    const pending = runGeneration(config, store, run.id, run.idea);
    store.pause(run.id);
    await pending;

    const final = store.get(run.id);
    expect(final?.status).toBe("paused");
    expect(final?.checkpoint?.stage).toBe("llm");
    expect(final?.checkpoint?.raw).toContain('{"summary":"partial"');
    expect(final?.logs.some((l) => l.includes("context retained"))).toBe(true);
  });

  it("resumes paused generation from the validation stage", async () => {
    const generateSpy = vi
      .spyOn(await import("../src/llm.js"), "generateProjectFromIdea")
      .mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const run = store.create("make app");
    store.markPaused(run.id, {
      kind: "generate",
      stage: "validate",
      idea: run.idea,
      contextState: {},
      project: { summary: "done", files: validPayload.files }
    });
    store.attachAbortController(run.id);

    await resumeRun(config, store, run.id);

    expect(generateSpy).not.toHaveBeenCalled();
    expect(store.get(run.id)?.status).toBe("done");
  });

  it("resumes follow-up, runtime repair, and validation repair checkpoints", async () => {
    const followUpSpy = vi
      .spyOn(await import("../src/llm.js"), "updateProjectFromFollowUp")
      .mockResolvedValue(JSON.stringify(validPayload));
    const runtimeSpy = vi
      .spyOn(await import("../src/llm.js"), "fixProjectFromRuntimeError")
      .mockResolvedValue(JSON.stringify(validPayload));
    const validationSpy = vi
      .spyOn(await import("../src/llm.js"), "fixProjectFromValidationErrors")
      .mockResolvedValue(JSON.stringify(validPayload));
    vi.spyOn(validateModule, "validateGeneratedProject").mockResolvedValue({
      lintOutput: "ok",
      testOutput: "ok"
    });

    const store = new RunStore();
    const sourceProject = { summary: "done", files: validPayload.files };

    const followUpRun = store.create("follow-up");
    store.markPaused(followUpRun.id, {
      kind: "follow_up",
      stage: "validate",
      idea: `${followUpRun.idea}\n\nFollow-up request: add score`,
      contextState: {},
      sourceProject,
      followUpPrompt: "add score",
      project: sourceProject
    });
    store.attachAbortController(followUpRun.id);
    await resumeRun(config, store, followUpRun.id);
    expect(followUpSpy).not.toHaveBeenCalled();
    expect(store.get(followUpRun.id)?.status).toBe("done");

    const runtimeRun = store.create("runtime");
    store.markPaused(runtimeRun.id, {
      kind: "runtime_repair",
      stage: "validate",
      idea: runtimeRun.idea,
      contextState: {},
      sourceProject,
      runtimeError: "crash",
      project: sourceProject
    });
    store.attachAbortController(runtimeRun.id);
    await resumeRun(config, store, runtimeRun.id);
    expect(runtimeSpy).not.toHaveBeenCalled();
    expect(store.get(runtimeRun.id)?.status).toBe("done");

    const validationRun = store.create("validation");
    store.markPaused(validationRun.id, {
      kind: "validation_repair",
      stage: "validate",
      idea: validationRun.idea,
      contextState: {},
      sourceProject,
      validationError: "lint",
      project: sourceProject
    });
    store.attachAbortController(validationRun.id);
    await resumeRun(config, store, validationRun.id);
    expect(validationSpy).not.toHaveBeenCalled();
    expect(store.get(validationRun.id)?.status).toBe("done");
  });

  it("fails resume when checkpoint data is incomplete", async () => {
    const store = new RunStore();
    const followUpRun = store.create("broken follow-up");
    store.markPaused(followUpRun.id, {
      kind: "follow_up",
      stage: "llm",
      idea: followUpRun.idea,
      contextState: {}
    });
    store.attachAbortController(followUpRun.id);
    await resumeRun(config, store, followUpRun.id);
    expect(store.get(followUpRun.id)?.status).toBe("error");
    expect(store.get(followUpRun.id)?.error).toContain("missing source project");

    const runtimeRun = store.create("broken runtime");
    store.markPaused(runtimeRun.id, {
      kind: "runtime_repair",
      stage: "llm",
      idea: runtimeRun.idea,
      contextState: {}
    });
    store.attachAbortController(runtimeRun.id);
    await resumeRun(config, store, runtimeRun.id);
    expect(store.get(runtimeRun.id)?.error).toContain("missing source project or error");

    const validationRun = store.create("broken validation");
    store.markPaused(validationRun.id, {
      kind: "validation_repair",
      stage: "llm",
      idea: validationRun.idea,
      contextState: {}
    });
    store.attachAbortController(validationRun.id);
    await resumeRun(config, store, validationRun.id);
    expect(store.get(validationRun.id)?.error).toContain("missing source project or error");
  });

  it("throws when resume is requested without a checkpoint", async () => {
    const store = new RunStore();
    const run = store.create("not paused");
    await expect(resumeRun(config, store, run.id)).rejects.toThrow(/not paused/i);
  });

  it("fails when resuming from parse without saved model output", async () => {
    const store = new RunStore();
    const run = store.create("missing raw");
    store.markPaused(run.id, {
      kind: "generate",
      stage: "parse",
      idea: run.idea,
      contextState: {}
    });
    store.attachAbortController(run.id);
    await resumeRun(config, store, run.id);
    expect(store.get(run.id)?.error).toContain("Missing model response for parse stage");

    const followUpRun = store.create("missing raw follow-up");
    store.markPaused(followUpRun.id, {
      kind: "follow_up",
      stage: "parse",
      idea: `${followUpRun.idea}\n\nFollow-up request: add score`,
      contextState: {},
      sourceProject: { summary: "done", files: validPayload.files },
      followUpPrompt: "add score"
    });
    store.attachAbortController(followUpRun.id);
    await resumeRun(config, store, followUpRun.id);
    expect(store.get(followUpRun.id)?.error).toContain("Missing model response for parse stage");

    const runtimeRun = store.create("missing raw runtime");
    store.markPaused(runtimeRun.id, {
      kind: "runtime_repair",
      stage: "parse",
      idea: runtimeRun.idea,
      contextState: {},
      sourceProject: { summary: "done", files: validPayload.files },
      runtimeError: "crash"
    });
    store.attachAbortController(runtimeRun.id);
    await resumeRun(config, store, runtimeRun.id);
    expect(store.get(runtimeRun.id)?.error).toContain("Missing model response for parse stage");

    const validationRun = store.create("missing raw validation");
    store.markPaused(validationRun.id, {
      kind: "validation_repair",
      stage: "parse",
      idea: validationRun.idea,
      contextState: {},
      sourceProject: { summary: "done", files: validPayload.files },
      validationError: "lint"
    });
    store.attachAbortController(validationRun.id);
    await resumeRun(config, store, validationRun.id);
    expect(store.get(validationRun.id)?.error).toContain("Missing model response for parse stage");
  });

  it("fails when resuming from validate without saved project", async () => {
    const store = new RunStore();
    const run = store.create("missing project");
    store.markPaused(run.id, {
      kind: "generate",
      stage: "validate",
      idea: run.idea,
      contextState: {}
    });
    store.attachAbortController(run.id);
    await resumeRun(config, store, run.id);
    expect(store.get(run.id)?.error).toContain("Missing parsed project for validation stage");

    const followUpRun = store.create("missing project follow-up");
    store.markPaused(followUpRun.id, {
      kind: "follow_up",
      stage: "validate",
      idea: `${followUpRun.idea}\n\nFollow-up request: add score`,
      contextState: {},
      sourceProject: { summary: "done", files: validPayload.files },
      followUpPrompt: "add score"
    });
    store.attachAbortController(followUpRun.id);
    await resumeRun(config, store, followUpRun.id);
    expect(store.get(followUpRun.id)?.error).toContain("Missing parsed project for validation stage");

    const runtimeRun = store.create("missing project runtime");
    store.markPaused(runtimeRun.id, {
      kind: "runtime_repair",
      stage: "validate",
      idea: runtimeRun.idea,
      contextState: {},
      sourceProject: { summary: "done", files: validPayload.files },
      runtimeError: "crash"
    });
    store.attachAbortController(runtimeRun.id);
    await resumeRun(config, store, runtimeRun.id);
    expect(store.get(runtimeRun.id)?.error).toContain("Missing parsed project for validation stage");

    const validationRun = store.create("missing project validation");
    store.markPaused(validationRun.id, {
      kind: "validation_repair",
      stage: "validate",
      idea: validationRun.idea,
      contextState: {},
      sourceProject: { summary: "done", files: validPayload.files },
      validationError: "lint"
    });
    store.attachAbortController(validationRun.id);
    await resumeRun(config, store, validationRun.id);
    expect(store.get(validationRun.id)?.error).toContain("Missing parsed project for validation stage");
  });

  it("keeps the checkpoint unchanged when pausing without streamed content", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockImplementation(
      async (_config, _idea, _handlers, options) => {
        await waitForAbort(options?.signal);
        return JSON.stringify(validPayload);
      }
    );

    const store = new RunStore();
    const run = store.create("make app");
    store.attachAbortController(run.id);
    const pending = runGeneration(config, store, run.id, run.idea);
    store.pause(run.id);
    await pending;

    expect(store.get(run.id)?.checkpoint?.raw).toBeUndefined();
  });

  it("pauses follow-up and runtime repair runs when aborted", async () => {
    vi.spyOn(await import("../src/llm.js"), "updateProjectFromFollowUp").mockImplementation(
      async (_config, _idea, _project, _prompt, _handlers, options) => {
        await waitForAbort(options?.signal);
        return JSON.stringify(validPayload);
      }
    );
    vi.spyOn(await import("../src/llm.js"), "fixProjectFromRuntimeError").mockImplementation(
      async (_config, _idea, _project, _error, _handlers, options) => {
        await waitForAbort(options?.signal);
        return JSON.stringify(validPayload);
      }
    );

    const store = new RunStore();
    const followUpRun = store.create("follow-up");
    store.attachAbortController(followUpRun.id);
    const followUpPending = runFollowUp(
      config,
      store,
      followUpRun.id,
      followUpRun.idea,
      { summary: "done", files: validPayload.files },
      "add score"
    );
    store.pause(followUpRun.id);
    await followUpPending;
    expect(store.get(followUpRun.id)?.status).toBe("paused");

    const runtimeRun = store.create("runtime");
    store.attachAbortController(runtimeRun.id);
    const runtimePending = runRuntimeRepair(
      config,
      store,
      runtimeRun.id,
      runtimeRun.idea,
      { summary: "done", files: validPayload.files },
      "crash"
    );
    store.pause(runtimeRun.id);
    await runtimePending;
    expect(store.get(runtimeRun.id)?.status).toBe("paused");
  });

  it("pauses validation repair and resumed runs when aborted", async () => {
    vi.spyOn(await import("../src/llm.js"), "fixProjectFromValidationErrors").mockImplementation(
      async (_config, _idea, _project, _error, _handlers, options) => {
        await waitForAbort(options?.signal);
        return JSON.stringify(validPayload);
      }
    );

    const store = new RunStore();
    const repairRun = store.create("repair");
    store.attachAbortController(repairRun.id);
    const repairPending = runValidationRepair(
      config,
      store,
      repairRun.id,
      repairRun.idea,
      { summary: "broken", files: validPayload.files },
      "lint"
    );
    store.pause(repairRun.id);
    await repairPending;
    expect(store.get(repairRun.id)?.status).toBe("paused");

    vi.spyOn(validateModule, "validateGeneratedProject").mockImplementation(
      async (_runId, _files, _onLog, _deps, signal) => {
        await waitForAbort(signal);
        return { lintOutput: "ok", testOutput: "ok" };
      }
    );
    const resumeRunRecord = store.create("resume pause");
    store.markPaused(resumeRunRecord.id, {
      kind: "generate",
      stage: "validate",
      idea: resumeRunRecord.idea,
      contextState: {},
      project: { summary: "done", files: validPayload.files }
    });
    store.attachAbortController(resumeRunRecord.id);
    const resumePending = resumeRun(config, store, resumeRunRecord.id);
    store.pause(resumeRunRecord.id);
    await resumePending;
    expect(store.get(resumeRunRecord.id)?.status).toBe("paused");
  });

  it("handles non-error failures during resume", async () => {
    vi.spyOn(validateModule, "validateGeneratedProject").mockRejectedValue("plain resume failure");

    const store = new RunStore();
    const run = store.create("make app");
    store.markPaused(run.id, {
      kind: "generate",
      stage: "validate",
      idea: run.idea,
      contextState: {},
      project: { summary: "done", files: validPayload.files }
    });
    store.attachAbortController(run.id);
    await resumeRun(config, store, run.id);
    expect(store.get(run.id)?.error).toBe("plain resume failure");
  });

  it("preserves partial files when a resumed run fails", async () => {
    vi.spyOn(await import("../src/llm.js"), "generateProjectFromIdea").mockResolvedValue(
      JSON.stringify(validPayload)
    );
    vi.spyOn(validateModule, "validateGeneratedProject").mockRejectedValue(
      new Error("lint still failing")
    );

    const store = new RunStore();
    const run = store.create("make app");
    store.markPaused(run.id, {
      kind: "generate",
      stage: "validate",
      idea: run.idea,
      contextState: {},
      project: { summary: "done", files: validPayload.files }
    });
    store.attachAbortController(run.id);
    await resumeRun(config, store, run.id);

    const final = store.get(run.id);
    expect(final?.status).toBe("error");
    expect(final?.files["index.js"]).toContain("export const x = 1");
  });
});
