import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  isMainModule,
  resolveCorsOrigins,
  sendIndexFallback,
  startServer
} from "../src/server.js";
import { testConfig } from "./helpers.js";

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

    const app = createApp(testConfig);
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("prism0");
    server.close();
  });

  it("skips index fallback for unknown api routes", async () => {
    const app = createApp(testConfig);
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/api/unknown-route`);
    expect(res.status).toBe(404);
    server.close();
  });

  it("falls through when frontend build is missing", async () => {
    const app = createApp(testConfig);
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/some-page`);
    expect(res.status).toBe(404);
    server.close();
  });

  it("serves /api/health", async () => {
    const app = createApp(testConfig);
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${addr.port}/api/health`;

    const res = await fetch(url);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    server.close();
  });

  it("sets security headers without enabling cross-origin access by default", async () => {
    const app = createApp(testConfig);
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`, {
      headers: { origin: "https://example.com" }
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()"
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    server.close();
  });

  it("uses the configured CORS origin when one is provided", async () => {
    const app = createApp({ ...testConfig, corsOrigin: "https://app.example" });
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`, {
      headers: { origin: "https://app.example" }
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");

    server.close();
  });
});

describe("resolveCorsOrigins", () => {
  it("returns a single origin when only one is configured", () => {
    expect(resolveCorsOrigins("https://app.example")).toBe("https://app.example");
  });

  it("returns multiple trimmed origins for comma-separated config", () => {
    expect(resolveCorsOrigins("https://one.example, https://two.example")).toEqual([
      "https://one.example",
      "https://two.example"
    ]);
  });
});

describe("sendIndexFallback", () => {
  it("passes api routes through", () => {
    const next = vi.fn();
    const res = { sendFile: vi.fn() } as unknown as express.Response;

    sendIndexFallback("/tmp/static", { path: "/api/missing" } as express.Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it("sends index.html for frontend routes", () => {
    const next = vi.fn();
    const res = {
      sendFile: vi.fn((_file: string, callback: (error?: Error) => void) => callback())
    } as unknown as express.Response;

    sendIndexFallback("/tmp/static", { path: "/app" } as express.Request, res, next);

    expect(res.sendFile).toHaveBeenCalledWith(
      path.join("/tmp/static", "index.html"),
      expect.any(Function)
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("delegates index send errors", () => {
    const next = vi.fn();
    const error = new Error("missing index");
    const res = {
      sendFile: vi.fn((_file: string, callback: (error?: Error) => void) => callback(error))
    } as unknown as express.Response;

    sendIndexFallback("/tmp/static", { path: "/app" } as express.Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
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
    const server = startServer({ ...testConfig, port: 0 });

    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    expect(typeof server.close).toBe("function");
    expect(log).toHaveBeenCalled();
    server.close();
    log.mockRestore();
  });
});
