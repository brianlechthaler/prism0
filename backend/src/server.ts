import cors from "cors";
import express from "express";
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

  app.use(cors());
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

export function isMainModule(argv: string[] = process.argv): boolean {
  return import.meta.url === pathToFileURL(argv[1] ?? "").href;
}

const isMain = isMainModule();

export function startServer(config: AppConfig) {
  const app = createApp(config);
  return app.listen(config.port, () => {
    console.log(`prism0 backend listening on http://localhost:${config.port}`);
  });
}

/* v8 ignore start */
if (isMain) {
  startServer(loadConfig(process.env, parseCliArgs(process.argv.slice(2))));
}
/* v8 ignore end */
