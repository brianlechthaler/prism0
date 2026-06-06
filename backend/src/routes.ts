import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { createProjectZip } from "./download.js";
import { runGeneration, runRuntimeRepair } from "./generator.js";
import type { RunStore } from "./runStore.js";

const GenerateBodySchema = z.object({
  idea: z.string().trim().min(3).max(2000)
});

const RuntimeFixBodySchema = z.object({
  error: z.string().trim().min(1).max(8000)
});

export function registerRoutes(app: Express, config: AppConfig, store: RunStore): void {
  const generationGuard = createGenerationGuard(config, store);

  app.post("/api/generate", generationGuard, (req, res) => {
    const parsed = GenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }

    const run = store.create(parsed.data.idea);
    void runGeneration(config, store, run.id, parsed.data.idea);
    res.json({ runId: run.id });
  });

  app.post("/api/generate/:runId/fix", generationGuard, (req, res) => {
    const sourceRun = store.get(req.params.runId);
    if (!sourceRun) {
      res.status(404).send("Run not found");
      return;
    }

    if (sourceRun.status !== "done" || Object.keys(sourceRun.files).length === 0) {
      res.status(409).send("Project is not ready to repair");
      return;
    }

    const parsed = RuntimeFixBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }

    const run = store.create(sourceRun.idea);
    void runRuntimeRepair(
      config,
      store,
      run.id,
      sourceRun.idea,
      {
        summary: `Runtime repair for run ${sourceRun.id}`,
        files: sourceRun.files
      },
      parsed.data.error
    );
    res.json({ runId: run.id });
  });

  app.get("/api/generate/:runId/events", (req, res) => {
    const runId = req.params.runId;
    const run = store.get(runId);
    if (!run) {
      res.status(404).send("Run not found");
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(": connected\n\n");

    const unsubscribe = store.subscribe(runId, (message) => {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
      if (message.type === "done" || message.type === "error") {
        res.end();
      }
    });

    req.on("close", () => unsubscribe());
  });

  app.get("/api/project/:runId/download", (req, res) => {
    const run = store.get(req.params.runId);
    if (!run || run.status !== "done") {
      res.status(404).send("Project not ready");
      return;
    }

    const zip = createProjectZip(run.files);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="prism0-${run.id}.zip"`);
    res.send(zip);
  });
}

type RateBucket = {
  count: number;
  resetAt: number;
};

export function createGenerationGuard(
  config: AppConfig,
  store: RunStore,
  now: () => number = Date.now
): RequestHandler {
  const buckets = new Map<string, RateBucket>();

  return (req, res, next) => {
    if (store.activeCount() >= config.maxActiveRuns) {
      res.status(503).send("Generation capacity reached; try again later");
      return;
    }

    const currentTime = now();
    const key = clientRateLimitKey(req);
    const existing = buckets.get(key);
    const bucket =
      existing && existing.resetAt > currentTime
        ? existing
        : { count: 0, resetAt: currentTime + config.generationRateLimitWindowMs };

    if (bucket.count >= config.generationRateLimitMax) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - currentTime) / 1000)));
      res.status(429).send("Too many generation requests; try again later");
      buckets.set(key, bucket);
      return;
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    next();
  };
}

function clientRateLimitKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}
