import cors from "cors";
import express from "express";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "./config.js";
import { parseCliArgs } from "./parseArgs.js";
import { registerRoutes } from "./routes.js";
import { RunStore } from "./runStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(config = loadConfig(process.env, parseCliArgs(process.argv.slice(2)))) {
  const app = express();
  const store = new RunStore();

  app.set("trust proxy", config.trustProxy);
  app.use(securityHeaders);
  if (config.corsOrigin) {
    app.use(cors({ origin: resolveCorsOrigins(config.corsOrigin) }));
  }
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  registerRoutes(app, config, store);

  const staticDir = path.resolve(__dirname, "../../frontend/dist");
  app.use(express.static(staticDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(staticDir, "index.html"), (err) => {
      if (err) next();
    });
  });

  return app;
}

export function resolveCorsOrigins(origin: string): string | string[] {
  const origins = origin
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return origins.length === 1 ? origins[0] : origins;
}

export function securityHeaders(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

export function isMainModule(argv: string[] = process.argv): boolean {
  return import.meta.url === pathToFileURL(argv[1] ?? "").href;
}

const isMain = isMainModule();

export function startServer(config: AppConfig) {
  const app = createApp(config);
  return app.listen(config.port, config.host, () => {
    console.log(`prism0 backend listening on http://${config.host}:${config.port}`);
  });
}

/* v8 ignore start */
function shutdown(server: Server, signal: NodeJS.Signals): void {
  console.log(`${signal} received; shutting down prism0 backend`);
  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close((error) => {
    clearTimeout(forceExit);
    if (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(0);
  });
}

if (isMain) {
  const server = startServer(loadConfig(process.env, parseCliArgs(process.argv.slice(2))));
  process.on("SIGTERM", () => shutdown(server, "SIGTERM"));
  process.on("SIGINT", () => shutdown(server, "SIGINT"));
}
/* v8 ignore end */
