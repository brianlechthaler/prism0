import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, isMainModule, startServer } from "../src/server.js";

const distDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../frontend/dist"
);

describe("createApp", () => {
  afterEach(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  it("serves the frontend index for non-api routes", async () => {
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "index.html"), "<html>prism0</html>");

    const app = createApp({
      openaiApiKey: "k",
      openaiBaseUrl: "https://example.com/v1",
      openaiModel: "m",
      port: 8787
    });
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("prism0");
    server.close();
  });

  it("skips index fallback for unknown api routes", async () => {
    const app = createApp({
      openaiApiKey: "k",
      openaiBaseUrl: "https://example.com/v1",
      openaiModel: "m",
      port: 8787
    });
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/api/unknown-route`);
    expect(res.status).toBe(404);
    server.close();
  });

  it("falls through when frontend build is missing", async () => {
    const app = createApp({
      openaiApiKey: "k",
      openaiBaseUrl: "https://example.com/v1",
      openaiModel: "m",
      port: 8787
    });
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/some-page`);
    expect(res.status).toBe(404);
    server.close();
  });

  it("serves /api/health", async () => {
    const app = createApp({
      openaiApiKey: "k",
      openaiBaseUrl: "https://example.com/v1",
      openaiModel: "m",
      port: 8787
    });
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${addr.port}/api/health`;

    const res = await fetch(url);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    server.close();
  });
});

describe("isMainModule", () => {
  it("handles missing argv entries", () => {
    expect(isMainModule([])).toBe(false);
  });
});

describe("startServer", () => {
  it("returns an http server and logs when listening", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const server = startServer({
      openaiApiKey: "k",
      openaiBaseUrl: "https://example.com/v1",
      openaiModel: "m",
      port: 0
    });

    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    expect(typeof server.close).toBe("function");
    expect(log).toHaveBeenCalled();
    server.close();
    log.mockRestore();
  });
});
