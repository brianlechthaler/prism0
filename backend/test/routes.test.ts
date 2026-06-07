import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createGenerationGuard, registerRoutes, routeParam } from "../src/routes.js";
import { RunStore } from "../src/runStore.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  openaiModels: ["m"],
  host: "127.0.0.1",
  port: 8787,
  requestTimeoutMs: 120_000,
  contextWindowTokens: 128_000,
  maxRuns: 100,
  maxActiveRuns: 100,
  generationRateLimitWindowMs: 60_000,
  generationRateLimitMax: 100,
  trustProxy: false
};

function createTestApp(store = new RunStore(), appConfig = config) {
  const app = express();
  app.use(express.json());
  registerRoutes(app, appConfig, store);
  return { app, store };
}

async function withServer<T>(app: express.Express, fn: (port: number) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  try {
    return await fn(addr.port);
  } finally {
    server.close();
  }
}

describe("registerRoutes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid generate payloads", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea: "no" })
      });
      expect(res.status).toBe(400);
    });
  });

  it("serves configured model options", async () => {
    const { app } = createTestApp(new RunStore(), {
      ...config,
      openaiModel: "primary",
      openaiModels: ["primary", "fallback"]
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/models`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        defaultModel: "primary",
        models: ["primary", "fallback"]
      });
    });
  });

  it("creates runs and serves project downloads", async () => {
    const { app, store } = createTestApp();
    const run = store.create("make app");
    store.complete(run.id, { "index.html": "<html></html>" });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/project/${run.id}/download`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("zip");
    });
  });

  it("returns 404 for missing downloads", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/project/missing/download`);
      expect(res.status).toBe(404);
    });
  });

  it("unsubscribes when the SSE client disconnects", async () => {
    const { app, store } = createTestApp();
    const run = store.create("make app");

    await withServer(app, async (port) => {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/generate/${run.id}/events`, {
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
    const run = store.create("make app");

    await withServer(app, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/generate/${run.id}/events`);
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
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/missing/events`);
      expect(res.status).toBe(404);
    });
  });

  it("starts generation asynchronously with the selected model", async () => {
    const generationSpy = vi
      .spyOn(await import("../src/generator.js"), "runGeneration")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp(new RunStore(), {
      ...config,
      openaiModels: ["m", "fallback"]
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea: "make a tiny app", model: "fallback" })
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { runId: string };
      expect(json.runId).toBeTruthy();
      expect(generationSpy).toHaveBeenCalledWith(
        { ...config, openaiModels: ["m", "fallback"] },
        store,
        json.runId,
        "make a tiny app",
        "fallback"
      );
    });
  });

  it("rejects unconfigured models", async () => {
    vi.spyOn(await import("../src/generator.js"), "runGeneration").mockResolvedValue(undefined);
    const { app } = createTestApp();

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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

    await withServer(app, async (port) => {
      const body = JSON.stringify({ idea: "make a tiny app" });
      const first = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      });
      const second = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("60");
    });
  });

  it("rejects new generation requests when active capacity is reached", async () => {
    const { app, store } = createTestApp(new RunStore(), { ...config, maxActiveRuns: 1 });
    store.create("already running");

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    const sourceRun = store.create("make app");
    store.complete(sourceRun.id, { "index.html": "<html></html>", "index.js": "throw new Error();" });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
        undefined
      );
    });
  });

  it("starts follow-up runs asynchronously", async () => {
    const followUpSpy = vi
      .spyOn(await import("../src/generator.js"), "runFollowUp")
      .mockResolvedValue(undefined);
    const { app, store } = createTestApp();
    const sourceRun = store.create("make app");
    store.complete(sourceRun.id, {
      "index.html": "<html></html>",
      "index.js": "export const x = 1;"
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
          files: expect.objectContaining({ "index.js": "export const x = 1;" })
        }),
        "add a settings panel",
        undefined
      );
    });
  });

  it("returns 404 for missing follow-up source runs", async () => {
    const { app } = createTestApp();

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/missing/follow-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "add settings" })
      });
      expect(res.status).toBe(404);
    });
  });

  it("rejects invalid follow-up payloads", async () => {
    const { app, store } = createTestApp();
    const sourceRun = store.create("make app");
    store.complete(sourceRun.id, { "index.html": "<html></html>" });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "" })
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects follow-up runs when the project is not ready", async () => {
    const { app, store } = createTestApp();
    const sourceRun = store.create("make app");

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/follow-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "add settings" })
      });
      expect(res.status).toBe(409);
    });
  });

  it("returns 404 for missing runtime repair source runs", async () => {
    const { app } = createTestApp();

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/missing/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Error: boom" })
      });
      expect(res.status).toBe(404);
    });
  });

  it("rejects invalid runtime repair payloads", async () => {
    const { app, store } = createTestApp();
    const sourceRun = store.create("make app");
    store.complete(sourceRun.id, { "index.html": "<html></html>", "index.js": "throw new Error();" });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "" })
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects runtime repair when the project is not ready", async () => {
    const { app, store } = createTestApp();
    const sourceRun = store.create("make app");

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate/${sourceRun.id}/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Error: boom" })
      });
      expect(res.status).toBe(409);
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
