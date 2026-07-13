import { afterEach, describe, expect, it, vi } from "vitest";
import type express from "express";
import { createGenerationGuard, isRepairableSourceRun, projectFromSourceRun, routeParam } from "../src/routes.js";
import { RunStore } from "../src/runStore.js";
import {
  createTestApp,
  registerAndLogin,
  testConfig as config,
  withAuthedServer,
  withServer
} from "./helpers.js";

function authHeaders(cookie: string): Record<string, string> {
  return { cookie, "content-type": "application/json" };
}

describe("registerRoutes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid generate payloads", async () => {
    const { app } = createTestApp();
    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "no" })
      });
      expect(res.status).toBe(400);
    });
  });

  it("allows generation without authentication when login is disabled", async () => {
    const { app } = createTestApp(new RunStore(), { ...config, authEnabled: false });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea: "make a counter app" })
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { runId: string };
      expect(json.runId).toMatch(/^[0-9a-f-]{36}$/i);
    });
  });

  it("hides configured model options when the model picker is disabled", async () => {
    const { app } = createTestApp(new RunStore(), {
      ...config,
      openaiModel: "primary",
      openaiModels: ["primary", "fallback"]
    });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/models`, { headers: authHeaders(cookie) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        enabled: false,
        defaultModel: "primary",
        models: [],
        yoloModeEnabled: false
      });
    });
  });

  it("serves configured model options when the model picker is enabled", async () => {
    const { app } = createTestApp(new RunStore(), {
      ...config,
      modelPickerEnabled: true,
      openaiModel: "primary",
      openaiModels: ["primary", "fallback"]
    });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/models`, { headers: authHeaders(cookie) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        enabled: true,
        defaultModel: "primary",
        models: ["primary", "fallback"],
        yoloModeEnabled: false
      });
    });
  });

  it("creates runs and serves project downloads", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const run = store.create("make app", userId);
      store.complete(run.id, { "index.html": "<html></html>" });

      const res = await fetch(`http://127.0.0.1:${port}/api/project/${run.id}/download`, {
        headers: authHeaders(cookie)
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("zip");
    });
  });

  it("returns 404 for missing downloads", async () => {
    const { app } = createTestApp();
    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/project/missing/download`, {
        headers: authHeaders(cookie)
      });
      expect(res.status).toBe(404);
    });
  });

  it("rejects cross-user run access", async () => {
    const { app, store } = createTestApp();

    await withServer(app, async (port) => {
      const userA = await registerAndLogin(port, "userA");
      const userB = await registerAndLogin(port, "userB");
      const run = store.create("make app", userA.userId);
      store.complete(run.id, { "index.html": "<html></html>" });

      const sseRes = await fetch(`http://127.0.0.1:${port}/api/generate/${run.id}/events`, {
        headers: authHeaders(userB.cookie)
      });
      expect(sseRes.status).toBe(403);

      const downloadRes = await fetch(`http://127.0.0.1:${port}/api/project/${run.id}/download`, {
        headers: authHeaders(userB.cookie)
      });
      expect(downloadRes.status).toBe(403);
    });
  });

  it("unsubscribes when the SSE client disconnects", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const run = store.create("make app", userId);

      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/generate/${run.id}/events`, {
        headers: authHeaders(cookie),
        signal: controller.signal
      });
      controller.abort();
      await response.text().catch(() => "closed");
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
    });
  });

  it("streams run events over SSE", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const run = store.create("make app", userId);

      const response = await fetch(`http://127.0.0.1:${port}/api/generate/${run.id}/events`, {
        headers: authHeaders(cookie)
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      store.appendLog(run.id, "working");
      store.updateUsage(run.id, {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        contextWindowTokens: 100,
        contextUsedTokens: 15,
        contextUsedPercent: 15,
        outputTokensPerSecond: 2.5,
        buckets: [
          {
            kind: "generate",
            label: "LLM generate",
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15
          }
        ]
      });
      store.complete(run.id, { "index.html": "<html/>" });

      const body = await response.text();
      expect(body).toContain('"type":"log"');
      expect(body).toContain("working");
      expect(body).toContain('"type":"usage"');
      expect(body).toContain('"contextUsedPercent":15');
      expect(body).toContain('"type":"done"');
    });
  });

  it("returns 404 for missing event streams", async () => {
    const { app } = createTestApp();
    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/missing/events`, {
        headers: authHeaders(cookie)
      });
      expect(res.status).toBe(404);
    });
  });

  it("stops, pauses, and resumes active runs", async () => {
    const resumeSpy = vi
      .spyOn(await import("../src/generator.js"), "resumeRun")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const run = store.create("make app", userId);
      store.setStatus(run.id, "running");
      store.attachAbortController(run.id);

      const stopRes = await fetch(`http://127.0.0.1:${port}/api/generate/${run.id}/stop`, {
        method: "POST",
        headers: authHeaders(cookie)
      });
      expect(stopRes.status).toBe(200);
      expect(await stopRes.json()).toEqual({ runId: run.id, status: "stopping" });

      const pauseRun = store.create("pause", userId);
      store.setStatus(pauseRun.id, "running");
      store.attachAbortController(pauseRun.id);
      const pauseRes = await fetch(`http://127.0.0.1:${port}/api/generate/${pauseRun.id}/pause`, {
        method: "POST",
        headers: authHeaders(cookie)
      });
      expect(pauseRes.status).toBe(200);

      store.markPaused(pauseRun.id, {
        kind: "generate",
        stage: "llm",
        idea: "pause",
        contextState: {}
      });
      const resumeRes = await fetch(`http://127.0.0.1:${port}/api/generate/${pauseRun.id}/resume`, {
        method: "POST",
        headers: authHeaders(cookie)
      });
      expect(resumeRes.status).toBe(200);
      expect(resumeSpy).toHaveBeenCalled();
    });
  });

  it("returns control errors for inactive or missing runs", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const doneRun = store.create("done", userId);
      store.complete(doneRun.id, { "index.html": "<html/>" });

      const headers = authHeaders(cookie);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/generate/missing/stop`, { method: "POST", headers }))
          .status
      ).toBe(404);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/generate/missing/pause`, { method: "POST", headers }))
          .status
      ).toBe(404);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/generate/missing/resume`, { method: "POST", headers }))
          .status
      ).toBe(404);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/generate/${doneRun.id}/stop`, { method: "POST", headers }))
          .status
      ).toBe(409);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/generate/${doneRun.id}/pause`, { method: "POST", headers }))
          .status
      ).toBe(409);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/generate/${doneRun.id}/resume`, { method: "POST", headers }))
          .status
      ).toBe(409);
    });
  });

  it("starts generation asynchronously with the selected model", async () => {
    const generationSpy = vi
      .spyOn(await import("../src/generator.js"), "runGeneration")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp(new RunStore(), {
      ...config,
      modelPickerEnabled: true,
      openaiModels: ["m", "fallback"]
    });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "make a tiny app", model: "fallback" })
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { runId: string };
      expect(json.runId).toBeTruthy();
      expect(generationSpy).toHaveBeenCalledWith(
        { ...config, modelPickerEnabled: true, openaiModels: ["m", "fallback"] },
        store,
        json.runId,
        "make a tiny app",
        "fallback",
        expect.objectContaining({ skipValidation: false })
      );
    });
  });

  it("starts YOLO generation when enabled and requested", async () => {
    const generationSpy = vi
      .spyOn(await import("../src/generator.js"), "runGeneration")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp(new RunStore(), { ...config, yoloModeEnabled: true });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "make a tiny app", yolo: true })
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { runId: string };
      expect(generationSpy).toHaveBeenCalledWith(
        { ...config, yoloModeEnabled: true },
        store,
        json.runId,
        "make a tiny app",
        undefined,
        expect.objectContaining({ skipValidation: true })
      );
    });
  });

  it("rejects YOLO generation when YOLO mode is disabled", async () => {
    vi.spyOn(await import("../src/generator.js"), "runGeneration").mockResolvedValue(undefined);
    const { app } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "make a tiny app", yolo: true })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("YOLO mode is disabled");
    });
  });

  it("rejects YOLO follow-up requests when YOLO mode is disabled", async () => {
    vi.spyOn(await import("../src/generator.js"), "runFollowUp").mockResolvedValue(undefined);
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>" });

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ prompt: "add settings", yolo: true })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("YOLO mode is disabled");
    });
  });

  it("rejects selected models when the model picker is disabled", async () => {
    vi.spyOn(await import("../src/generator.js"), "runGeneration").mockResolvedValue(undefined);
    const { app } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "make a tiny app", model: "missing" })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("disabled");
    });
  });

  it("rejects unconfigured models when the model picker is enabled", async () => {
    vi.spyOn(await import("../src/generator.js"), "runGeneration").mockResolvedValue(undefined);
    const { app } = createTestApp(new RunStore(), { ...config, modelPickerEnabled: true });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "make a tiny app", model: "missing" })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("not configured");
    });
  });

  it("rate limits generation requests by client", async () => {
    vi.spyOn(await import("../src/generator.js"), "runGeneration").mockResolvedValue(undefined);
    const { app } = createTestApp(new RunStore(), {
      ...config,
      generationRateLimitMax: 1,
      generationRateLimitWindowMs: 60_000
    });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const body = JSON.stringify({ idea: "make a tiny app" });
      const first = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body
      });
      const second = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("60");
    });
  });

  it("rejects new generation requests when active capacity is reached", async () => {
    const { app, store } = createTestApp(new RunStore(), { ...config, maxActiveRuns: 1 });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      store.create("already running", userId);

      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "make another tiny app" })
      });

      expect(res.status).toBe(503);
    });
  });

  it("starts runtime repair asynchronously", async () => {
    const repairSpy = vi
      .spyOn(await import("../src/generator.js"), "runRuntimeRepair")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>", "index.js": "throw new Error();" });

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/fix`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ error: "Error: boom" })
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { runId: string };
      expect(json.runId).toBeTruthy();
      expect(json.runId).not.toBe(sourceRun.id);
      expect(repairSpy).toHaveBeenCalledWith(
        config,
        store,
        json.runId,
        "make app",
        expect.objectContaining({
          files: expect.objectContaining({ "index.js": "throw new Error();" })
        }),
        "Error: boom",
        undefined,
        expect.objectContaining({ hooks: expect.any(Object) })
      );
    });
  });

  it("starts follow-up runs asynchronously", async () => {
    const followUpSpy = vi
      .spyOn(await import("../src/generator.js"), "runFollowUp")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(
        sourceRun.id,
        {
          "index.html": "<html></html>",
          "index.js": "export const x = 1;"
        },
        "A tiny counter app"
      );

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ prompt: "add a settings panel" })
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { runId: string };
      expect(json.runId).toBeTruthy();
      expect(json.runId).not.toBe(sourceRun.id);
      expect(store.get(json.runId)?.idea).toContain("Follow-up request: add a settings panel");
      expect(followUpSpy).toHaveBeenCalledWith(
        config,
        store,
        json.runId,
        "make app",
        expect.objectContaining({
          summary: "A tiny counter app",
          files: expect.objectContaining({ "index.js": "export const x = 1;" })
        }),
        "add a settings panel",
        undefined,
        expect.objectContaining({ skipValidation: false })
      );
    });
  });

  it("returns 404 for missing follow-up source runs", async () => {
    const { app } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/missing/follow-up`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ prompt: "add settings" })
      });
      expect(res.status).toBe(404);
    });
  });

  it("rejects invalid follow-up payloads", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>" });

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ prompt: "" })
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects unconfigured follow-up models", async () => {
    const { app, store } = createTestApp(new RunStore(), { ...config, modelPickerEnabled: true });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>" });

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ prompt: "add settings", model: "missing" })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("not configured");
    });
  });

  it("rejects follow-up runs when the project is not ready", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ prompt: "add settings" })
      });
      expect(res.status).toBe(409);
    });
  });

  it("returns 404 for missing runtime repair source runs", async () => {
    const { app } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/missing/fix`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ error: "Error: boom" })
      });
      expect(res.status).toBe(404);
    });
  });

  it("rejects invalid runtime repair payloads", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>", "index.js": "throw new Error();" });

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/fix`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ error: "" })
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects unconfigured runtime repair models", async () => {
    const { app, store } = createTestApp(new RunStore(), { ...config, modelPickerEnabled: true });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>", "index.js": "throw new Error();" });

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/fix`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ error: "Error: boom", model: "missing" })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("not configured");
    });
  });

  it("rejects runtime repair when the project is not ready", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/fix`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ error: "Error: boom" })
      });
      expect(res.status).toBe(409);
    });
  });

  it("starts validation repair asynchronously", async () => {
    const repairSpy = vi
      .spyOn(await import("../src/generator.js"), "runValidationRepair")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.setFiles(sourceRun.id, { "index.html": "<html></html>", "index.js": "broken();" });
      store.fail(sourceRun.id, "lint still failing");

      const res = await fetch(
        `http://127.0.0.1:${port}/api/generate/${sourceRun.id}/validation-fix`,
        {
          method: "POST",
          headers: authHeaders(cookie),
          body: JSON.stringify({ error: "lint still failing" })
        }
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { runId: string };
      expect(json.runId).toBeTruthy();
      expect(json.runId).not.toBe(sourceRun.id);
      expect(repairSpy).toHaveBeenCalledWith(
        config,
        store,
        json.runId,
        "make app",
        expect.objectContaining({
          files: expect.objectContaining({ "index.js": "broken();" })
        }),
        "lint still failing",
        undefined,
        expect.objectContaining({ hooks: expect.any(Object) })
      );
    });
  });

  it("returns 404 for missing validation repair source runs", async () => {
    const { app } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/missing/validation-fix`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ error: "lint still failing" })
      });
      expect(res.status).toBe(404);
    });
  });

  it("rejects invalid validation repair payloads", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.setFiles(sourceRun.id, { "index.html": "<html></html>" });
      store.fail(sourceRun.id, "lint still failing");

      const res = await fetch(
        `http://127.0.0.1:${port}/api/generate/${sourceRun.id}/validation-fix`,
        {
          method: "POST",
          headers: authHeaders(cookie),
          body: JSON.stringify({ error: "" })
        }
      );
      expect(res.status).toBe(400);
    });
  });

  it("rejects unconfigured validation repair models", async () => {
    const { app, store } = createTestApp(new RunStore(), { ...config, modelPickerEnabled: true });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.setFiles(sourceRun.id, { "index.html": "<html></html>" });
      store.fail(sourceRun.id, "lint still failing");

      const res = await fetch(
        `http://127.0.0.1:${port}/api/generate/${sourceRun.id}/validation-fix`,
        {
          method: "POST",
          headers: authHeaders(cookie),
          body: JSON.stringify({ error: "lint still failing", model: "missing" })
        }
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("not configured");
    });
  });

  it("rejects validation repair when the project is not ready", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);

      const res = await fetch(
        `http://127.0.0.1:${port}/api/generate/${sourceRun.id}/validation-fix`,
        {
          method: "POST",
          headers: authHeaders(cookie),
          body: JSON.stringify({ error: "lint still failing" })
        }
      );
      expect(res.status).toBe(409);
    });
  });

  it("allows runtime repair from failed runs with files", async () => {
    const repairSpy = vi
      .spyOn(await import("../src/generator.js"), "runRuntimeRepair")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.setFiles(sourceRun.id, { "index.html": "<html></html>", "index.js": "throw new Error();" });
      store.fail(sourceRun.id, "runtime repair failed");

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/fix`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ error: "Error: boom" })
      });
      expect(res.status).toBe(200);
      expect(repairSpy).toHaveBeenCalled();
    });
  });

  it("records generation history on completion and failure", async () => {
    const generator = await import("../src/generator.js");
    const { app, services } = createTestApp();

    vi.spyOn(generator, "runGeneration").mockImplementation((_config, _store, runId, _idea, _model, options) => {
      options?.hooks?.onComplete?.(runId, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
      return Promise.resolve();
    });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "make history app" })
      });
      const { runId } = (await res.json()) as { runId: string };
      expect(services.history.getByRunId(runId)?.status).toBe("done");
    });

    vi.spyOn(generator, "runGeneration").mockImplementation((_config, _store, runId, _idea, _model, options) => {
      options?.hooks?.onFail?.(runId, { inputTokens: 1, outputTokens: 0, totalTokens: 1 });
      return Promise.resolve();
    });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ idea: "make failing history app" })
      });
      const { runId } = (await res.json()) as { runId: string };
      expect(services.history.getByRunId(runId)?.status).toBe("error");
    });
  });

  it("rejects generation requests for foreign project ids", async () => {
    const { app } = createTestApp();

    await withAuthedServer(app, async (port, { cookie }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({
          idea: "make a counter app",
          projectId: crypto.randomUUID()
        })
      });
      expect(res.status).toBe(403);
    });
  });

  it("rejects follow-up requests for foreign project ids", async () => {
    const { app, store } = createTestApp();

    await withServer(app, async (port) => {
      const owner = await registerAndLogin(port, `follow_owner_${port}`);
      const other = await registerAndLogin(port, `follow_other_${port}`);
      const sourceRun = store.create("make app", owner.userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>" });
      const published = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: authHeaders(owner.cookie),
        body: JSON.stringify({ runId: sourceRun.id, name: "Follow-up App" })
      });
      const { project } = (await published.json()) as { project: { id: string } };

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: authHeaders(other.cookie),
        body: JSON.stringify({ prompt: "add dark mode", projectId: project.id })
      });
      expect(res.status).toBe(403);
    });
  });

  it("rejects follow-up requests when the caller owns the run but not the project", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>" });

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ prompt: "add dark mode", projectId: crypto.randomUUID() })
      });
      expect(res.status).toBe(403);
    });
  });

  it("accepts follow-up requests with owned project ids", async () => {
    const followUpSpy = vi
      .spyOn(await import("../src/generator.js"), "runFollowUp")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const sourceRun = store.create("make app", userId);
      store.complete(sourceRun.id, { "index.html": "<html></html>" });
      const published = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ runId: sourceRun.id, name: "Follow-up App" })
      });
      const { project } = (await published.json()) as { project: { id: string } };

      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: authHeaders(cookie),
        body: JSON.stringify({ prompt: "add dark mode", projectId: project.id })
      });
      expect(res.status).toBe(200);
      expect(followUpSpy).toHaveBeenCalled();
    });
  });

  it("returns not ready for incomplete project downloads", async () => {
    const { app, store } = createTestApp();

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const run = store.create("make app", userId);
      store.setStatus(run.id, "running");

      const res = await fetch(`http://127.0.0.1:${port}/api/project/${run.id}/download`, {
        headers: authHeaders(cookie)
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Project not ready");
    });
  });
});

describe("createGenerationGuard", () => {
  it("resets rate-limit buckets after the configured window", () => {
    let currentTime = 0;
    const guard = createGenerationGuard(
      { ...config, generationRateLimitMax: 1, generationRateLimitWindowMs: 10 },
      new RunStore(),
      () => currentTime
    );
    const req = { ip: "127.0.0.1", socket: {} } as express.Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      setHeader: vi.fn()
    } as unknown as express.Response;
    const next = vi.fn();

    guard(req, res, next);
    currentTime = 11;
    guard(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("falls back to socket and unknown client keys", () => {
    const guard = createGenerationGuard(config, new RunStore());
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      setHeader: vi.fn()
    } as unknown as express.Response;
    const next = vi.fn();

    guard({ ip: "", socket: { remoteAddress: "socket-client" } } as express.Request, res, next);
    guard({ ip: "", socket: {} } as express.Request, res, next);

    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe("routeParam", () => {
  it("returns strings and rejects non-single route params", () => {
    expect(routeParam("run-1")).toBe("run-1");
    expect(routeParam(["run-1", "run-2"])).toBe("");
    expect(routeParam(undefined)).toBe("");
  });
});

describe("projectFromSourceRun", () => {
  it("uses stored summary when available", () => {
    expect(
      projectFromSourceRun({
        id: "r1",
        idea: "make app",
        status: "done",
        logs: [],
        files: { "index.js": "x" },
        summary: "A tiny counter app"
      })
    ).toEqual({
      summary: "A tiny counter app",
      files: { "index.js": "x" }
    });
  });

  it("falls back to the original idea when summary is missing", () => {
    expect(
      projectFromSourceRun({
        id: "r1",
        idea: "make app",
        status: "done",
        logs: [],
        files: { "index.js": "x" }
      })
    ).toEqual({
      summary: "make app",
      files: { "index.js": "x" }
    });
  });
});

describe("isRepairableSourceRun", () => {
  it("accepts done and error runs with files", () => {
    expect(
      isRepairableSourceRun({
        id: "r1",
        idea: "make app",
        status: "done",
        logs: [],
        files: { "index.js": "x" }
      })
    ).toBe(true);
    expect(
      isRepairableSourceRun({
        id: "r1",
        idea: "make app",
        status: "error",
        logs: [],
        files: { "index.js": "x" },
        error: "boom"
      })
    ).toBe(true);
  });

  it("rejects runs without files or in non-terminal states", () => {
    expect(
      isRepairableSourceRun({
        id: "r1",
        idea: "make app",
        status: "done",
        logs: [],
        files: {}
      })
    ).toBe(false);
    expect(
      isRepairableSourceRun({
        id: "r1",
        idea: "make app",
        status: "running",
        logs: [],
        files: { "index.js": "x" }
      })
    ).toBe(false);
  });
});
