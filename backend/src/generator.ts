import type { AppConfig } from "./config.js";
import { generateProjectFromIdea } from "./llm.js";
import { parseGeneratedResponse } from "./parseGenerated.js";
import type { RunStore } from "./runStore.js";
import { validateGeneratedProject } from "./validateProject.js";

function timestamp(): string {
  return new Date().toISOString();
}

export async function runGeneration(
  config: AppConfig,
  store: RunStore,
  runId: string,
  idea: string
): Promise<void> {
  try {
    store.setStatus(runId, "running");
    store.appendLog(runId, `[${timestamp()}] prism0 run ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Idea received: "${idea}"`);
    store.appendLog(
      runId,
      `[${timestamp()}] Using model ${config.openaiModel} at ${config.openaiBaseUrl}`
    );

    store.appendLog(runId, `[${timestamp()}] Building generation prompt with TDD requirements…`);
    store.appendLog(
      runId,
      `[${timestamp()}] Calling OpenAI-compatible chat completions API (streaming enabled)…`
    );

    let streamedChars = 0;
    let streamedReasoningChars = 0;

    const raw = await generateProjectFromIdea(config, idea, {
      onReasoning: (chunk) => {
        streamedReasoningChars += chunk.length;
        if (streamedReasoningChars % 400 < chunk.length) {
          store.appendLog(
            runId,
            `[${timestamp()}] Model reasoning stream… ${streamedReasoningChars} chars so far`
          );
        }
      },
      onContent: (chunk) => {
        streamedChars += chunk.length;
        if (streamedChars % 500 < chunk.length) {
          store.appendLog(
            runId,
            `[${timestamp()}] Model content stream… ${streamedChars} chars received`
          );
        }
      }
    });

    store.appendLog(
      runId,
      `[${timestamp()}] Model response complete (${raw.length} chars total, ${streamedReasoningChars} reasoning chars)`
    );

    store.appendLog(runId, `[${timestamp()}] Parsing generated JSON project payload…`);
    const project = parseGeneratedResponse(raw);
    store.appendLog(
      runId,
      `[${timestamp()}] Parsed project summary: ${project.summary}`
    );
    store.appendLog(
      runId,
      `[${timestamp()}] Generated files: ${Object.keys(project.files).join(", ")}`
    );

    store.appendLog(
      runId,
      `[${timestamp()}] Starting backend validation pipeline (lint → tests)…`
    );
    await validateGeneratedProject(runId, project.files, (line) => {
      store.appendLog(runId, `[${timestamp()}] ${line}`);
    });

    store.appendLog(runId, `[${timestamp()}] All checks passed. Publishing files to editor/preview.`);
    store.complete(runId, project.files);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Run failed: ${message}`);
    store.fail(runId, message);
  }
}
