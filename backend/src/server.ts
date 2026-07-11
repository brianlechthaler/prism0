import cors from "cors";
import express from "express";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuthService } from "./auth.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { createAuthMiddleware } from "./authMiddleware.js";
import { loadConfig, type AppConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createEmailSender } from "./email.js";
import { GenerationHistoryService } from "./generationHistory.js";
import { registerHostingRoutes } from "./hosting.js";
import { parseCliArgs } from "./parseArgs.js";
import { ProjectStore } from "./projectStore.js";
import { registerProjectRoutes } from "./projectRoutes.js";
import { shutdownOpencode } from "./opencodeService.js";
import { registerRoutes } from "./routes.js";
import { RunStore } from "./runStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AppServices = {
  auth: AuthService;
  projects: ProjectStore;
  history: GenerationHistoryService;
};

export function createServices(config: AppConfig): AppServices {
  const db = openDatabase(config.databasePath);
  const sendEmail = createEmailSender({ mode: "console" });
  const auth = new AuthService({
    db,
    sendEmail,
    appBaseUrl: config.appBaseUrl,
    sessionTtlMs: config.sessionTtlMs,
    exposeVerificationToken: config.authExposeVerificationToken,
    emailEnabled: config.authEmailEnabled
  });
  const projects = new ProjectStore({ db, appBaseUrl: config.appBaseUrl });
  const history = new GenerationHistoryService(db);
  return { auth, projects, history };
}

export function createApp(
  config = loadConfig(process.env, parseCliArgs(process.argv.slice(2))),
  services = createServices(config)
) {
  const app = express();
  const store = new RunStore({ maxRuns: config.maxRuns });

  app.set("trust proxy", config.trustProxy);
  app.use(securityHeaders);
  if (config.corsOrigin) {
    app.use(cors({ origin: resolveCorsOrigins(config.corsOrigin), credentials: true }));
  }
  app.use(express.json({ limit: "2mb" }));
  app.use(createAuthMiddleware(services.auth));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  registerAuthRoutes(app, services.auth, services.projects, services.history, config);
  registerProjectRoutes(app, services.projects, store, config.authEnabled);
  registerHostingRoutes(app, services.projects);
  registerRoutes(app, config, store, { history: services.history });

  const staticDir = path.resolve(__dirname, "../../frontend/dist");
  app.use(express.static(staticDir));
  app.get(/.*/, (req, res, next) => sendIndexFallback(staticDir, req, res, next));

  return app;
}

export function sendIndexFallback(
  staticDir: string,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (req.path.startsWith("/api/") || req.path.startsWith("/h/")) return next();
  res.sendFile(path.join(staticDir, "index.html"), (err) => {
    if (err) next();
  });
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

  server.close(async (error) => {
    clearTimeout(forceExit);
    await shutdownOpencode().catch(() => undefined);
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
