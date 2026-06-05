import type { Express } from "express";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { createProjectZip } from "./download.js";
import { runGeneration } from "./generator.js";
import type { RunStore } from "./runStore.js";

const GenerateBodySchema = z.object({
  idea: z.string().trim().min(3).max(2000)
});

export function registerRoutes(app: Express, config: AppConfig, store: RunStore): void {
  app.post("/api/generate", (req, res) => {
    const parsed = GenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }

    const run = store.create(parsed.data.idea);
    void runGeneration(config, store, run.id, parsed.data.idea);
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
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

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
