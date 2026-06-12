import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "./authMiddleware.js";
import { requireAuth } from "./authMiddleware.js";
import type { AppConfig } from "./config.js";
import { createProjectZip } from "./download.js";
import type { GenerationHistoryService } from "./generationHistory.js";
import { runFollowUp, runGeneration, runRuntimeRepair, runValidationRepair } from "./generator.js";
import type { RunStore } from "./runStore.js";
import type { GenerationRun, GeneratedProject } from "./types.js";

const GenerateBodySchema = z.object({
  idea: z.string().trim().min(3).max(2000),
  model: z.string().trim().min(1).max(200).optional(),
  yolo: z.boolean().optional()
});

const RuntimeFixBodySchema = z.object({
  error: z.string().trim().min(1).max(8000),
  model: z.string().trim().min(1).max(200).optional()
});

const ValidationFixBodySchema = z.object({
  error: z.string().trim().min(1).max(8000),
  model: z.string().trim().min(1).max(200).optional()
});

const FollowUpBodySchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  model: z.string().trim().min(1).max(200).optional(),
  yolo: z.boolean().optional(),
  projectId: z.string().uuid().optional()
});

const GenerateBodySchemaWithProject = GenerateBodySchema.extend({
  projectId: z.string().uuid().optional()
});

export type RouteServices = {
  history: GenerationHistoryService;
};

export function registerRoutes(
  app: Express,
  config: AppConfig,
  store: RunStore,
  services: RouteServices
): void {
  const generationGuard = createGenerationGuard(config, store);
  const authRequired = requireAuth();

  app.get("/api/models", authRequired, (_req, res) => {
    res.json({
      enabled: config.modelPickerEnabled,
      defaultModel: config.openaiModel,
      models: config.modelPickerEnabled ? config.openaiModels : [],
      yoloModeEnabled: config.yoloModeEnabled
    });
  });

  app.post("/api/generate", authRequired, generationGuard, (req, res) => {
    const parsed = GenerateBodySchemaWithProject.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }

    const selectedModel = validateSelectedModel(config, parsed.data.model);
    if (selectedModel instanceof Error) {
      res.status(400).send(selectedModel.message);
      return;
    }

    const skipValidation = validateYoloRequest(config, parsed.data.yolo);
    if (skipValidation instanceof Error) {
      res.status(400).send(skipValidation.message);
      return;
    }

    const user = (req as AuthenticatedRequest).user!;
    const run = store.create(parsed.data.idea);
    services.history.recordStart(user.id, run.id, parsed.data.idea, parsed.data.projectId);
    void runGeneration(config, store, run.id, parsed.data.idea, selectedModel, {
      skipValidation,
      hooks: createHistoryHooks(services.history)
    });
    res.json({ runId: run.id });
  });

  app.post("/api/generate/:runId/follow-up", authRequired, generationGuard, (req, res) => {
    const sourceRun = store.get(routeParam(req.params.runId));
    if (!sourceRun) {
      res.status(404).send("Run not found");
      return;
    }

    if (sourceRun.status !== "done" || Object.keys(sourceRun.files).length === 0) {
      res.status(409).send("Project is not ready for follow-up changes");
      return;
    }

    const parsed = FollowUpBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }

    const selectedModel = validateSelectedModel(config, parsed.data.model);
    if (selectedModel instanceof Error) {
      res.status(400).send(selectedModel.message);
      return;
    }

    const skipValidation = validateYoloRequest(config, parsed.data.yolo);
    if (skipValidation instanceof Error) {
      res.status(400).send(skipValidation.message);
      return;
    }

    const user = (req as AuthenticatedRequest).user!;
    const followUpIdea = `${sourceRun.idea}\n\nFollow-up request: ${parsed.data.prompt}`;
    const run = store.create(followUpIdea);
    services.history.recordStart(user.id, run.id, followUpIdea, parsed.data.projectId);
    void runFollowUp(
      config,
      store,
      run.id,
      sourceRun.idea,
      projectFromSourceRun(sourceRun),
      parsed.data.prompt,
      selectedModel,
      { skipValidation, hooks: createHistoryHooks(services.history) }
    );
    res.json({ runId: run.id });
  });

  app.post("/api/generate/:runId/fix", authRequired, generationGuard, (req, res) => {
    const sourceRun = store.get(routeParam(req.params.runId));
    if (!sourceRun) {
      res.status(404).send("Run not found");
      return;
    }

    if (!isRepairableSourceRun(sourceRun)) {
      res.status(409).send("Project is not ready to repair");
      return;
    }

    const parsed = RuntimeFixBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }

    const selectedModel = validateSelectedModel(config, parsed.data.model);
    if (selectedModel instanceof Error) {
      res.status(400).send(selectedModel.message);
      return;
    }

    const user = (req as AuthenticatedRequest).user!;
    const run = store.create(sourceRun.idea);
    services.history.recordStart(user.id, run.id, sourceRun.idea);
    void runRuntimeRepair(
      config,
      store,
      run.id,
      sourceRun.idea,
      projectFromSourceRun(sourceRun),
      parsed.data.error,
      selectedModel,
      { hooks: createHistoryHooks(services.history) }
    );
    res.json({ runId: run.id });
  });

  app.post("/api/generate/:runId/validation-fix", authRequired, generationGuard, (req, res) => {
    const sourceRun = store.get(routeParam(req.params.runId));
    if (!sourceRun) {
      res.status(404).send("Run not found");
      return;
    }

    if (!isRepairableSourceRun(sourceRun)) {
      res.status(409).send("Project is not ready to repair");
      return;
    }

    const parsed = ValidationFixBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }

    const selectedModel = validateSelectedModel(config, parsed.data.model);
    if (selectedModel instanceof Error) {
      res.status(400).send(selectedModel.message);
      return;
    }

    const user = (req as AuthenticatedRequest).user!;
    const run = store.create(sourceRun.idea);
    services.history.recordStart(user.id, run.id, sourceRun.idea);
    void runValidationRepair(
      config,
      store,
      run.id,
      sourceRun.idea,
      projectFromSourceRun(sourceRun),
      parsed.data.error,
      selectedModel,
      { hooks: createHistoryHooks(services.history) }
    );
    res.json({ runId: run.id });
  });

  app.get("/api/generate/:runId/events", authRequired, (req, res) => {
    const runId = routeParam(req.params.runId);
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

  app.get("/api/project/:runId/download", authRequired, (req, res) => {
    const run = store.get(routeParam(req.params.runId));
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

export function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export function projectFromSourceRun(run: GenerationRun): GeneratedProject {
  return {
    summary: run.summary ?? run.idea,
    files: run.files
  };
}

export function isRepairableSourceRun(run: GenerationRun): boolean {
  return (
    Object.keys(run.files).length > 0 && (run.status === "done" || run.status === "error")
  );
}

export function validateSelectedModel(config: AppConfig, model?: string): string | undefined | Error {
  if (!model) return undefined;
  if (!config.modelPickerEnabled) return new Error("Model picker is disabled");
  if (config.openaiModels.includes(model)) return model;
  return new Error(
    `Model "${model}" is not configured. Available models: ${config.openaiModels.join(", ")}`
  );
}

export function validateYoloRequest(config: AppConfig, yolo?: boolean): boolean | Error {
  if (!yolo) return false;
  if (!config.yoloModeEnabled) return new Error("YOLO mode is disabled");
  return true;
}

function createHistoryHooks(history: GenerationHistoryService) {
  return {
    onComplete: (runId: string, usage?: import("./types.js").RunUsageMetrics) => {
      history.recordComplete(runId, usage);
    },
    onFail: (runId: string, usage?: import("./types.js").RunUsageMetrics) => {
      history.recordFailure(runId, usage);
    }
  };
}
