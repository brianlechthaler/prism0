import { z } from "zod";
import type { AppConfig } from "./config.js";
import { compressRunContextWithModel } from "./llm.js";
import { buildContextCompressionPrompt } from "./prompts.js";
import type { RunStore } from "./runStore.js";
import type { GeneratedProject, RunContextState } from "./types.js";
import type { RunUsageTracker } from "./usageTracker.js";
import type { StreamHandlers } from "./llm.js";

const ContextSummarySchema = z.object({
  summary: z.string().min(1)
});

export function parseContextSummaryResponse(raw: string): string {
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const candidate =
    firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : trimmed;

  const parsed = ContextSummarySchema.parse(JSON.parse(candidate));
  return parsed.summary;
}

export function augmentIdeaWithContext(idea: string, contextSummary?: string): string {
  if (!contextSummary) return idea;
  return `${idea}\n\nPrior run context (compressed):\n${contextSummary}`;
}

export async function maybeCompressRunContext(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  idea: string,
  project: GeneratedProject | undefined,
  contextState: RunContextState,
  handlers: StreamHandlers,
  selectedModel?: string
): Promise<{ idea: string; contextState: RunContextState }> {
  if (!tracker.isNearLimit(config.contextCompressThreshold)) {
    return { idea, contextState };
  }

  const usedPercent = tracker.snapshot().contextUsedPercent;
  store.appendLog(
    runId,
    `[${new Date().toISOString()}] Context window at ${usedPercent.toFixed(1)}%; compressing run context…`
  );

  const prompt = buildContextCompressionPrompt({
    idea,
    project,
    recentLogs: store.get(runId)!.logs,
    priorSummary: contextState.contextSummary,
    contextUsedPercent: usedPercent
  });

  const raw = await compressRunContextWithModel(
    config,
    prompt,
    handlers,
    selectedModel ? { selectedModel } : {}
  );
  const summary = parseContextSummaryResponse(raw);

  tracker.reset();
  store.updateUsage(runId, tracker.snapshot());

  store.appendLog(
    runId,
    `[${new Date().toISOString()}] Context compressed and usage counter reset. Continuing generation.`
  );

  return {
    idea: augmentIdeaWithContext(idea, summary),
    contextState: { contextSummary: summary }
  };
}
