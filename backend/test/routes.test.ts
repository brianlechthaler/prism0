import { describe, expect, it, vi } from "vitest";
import express from "express";
import { registerRoutes } from "../src/routes.js";
import { RunStore } from "../src/runStore.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  port: 8787,
  requestTimeoutMs: 120_000
};

function createTestApp(store = new RunStore()) {
  const app = express();
  app.use(express.json());
  registerRoutes(app, config, store);
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
    });
  });

  it("streams run events over SSE", async () => {
    const { app, store } = createTestApp();
    const run = store.create("make app");

    await withServer(app, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/generate/${run.id}/events`);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      store.appendLog(run.id, "working");
      store.complete(run.id, { "index.html": "<html/>" });

      const body = await response.text();
      expect(body).toContain('"type":"log"');
      expect(body).toContain("working");
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

  it("starts generation asynchronously", async () => {
    vi.spyOn(await import("../src/generator.js"), "runGeneration").mockResolvedValue(undefined);
    const { app } = createTestApp();

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea: "make a tiny app" })
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { runId: string };
      expect(json.runId).toBeTruthy();
    });
  });
});
