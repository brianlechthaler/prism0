import type { AppConfig } from "./config.js";
import {
  fixInvalidJsonResponse,
  fixProjectFromRuntimeError,
  fixProjectFromValidationErrors,
  generateProjectFromIdea,
  updateProjectFromFollowUp,
  type StreamHandlers
} from "./llm.js";
import { parseGeneratedResponse } from "./parseGenerated.js";
import { MAX_PARSE_ATTEMPTS, MAX_VALIDATION_ATTEMPTS } from "./prompts.js";
import type { RunStore } from "./runStore.js";
import type { GeneratedProject, LlmCompletionUsage, LlmUsageKind } from "./types.js";
import { estimateTokensFromText, RunUsageTracker } from "./usageTracker.js";
import { validateGeneratedProject } from "./validateProject.js";

function timestamp(): string {
  return new Date().toISOString();
}

async function parseProjectWithRetries(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  idea: string,
  raw: string,
  handlers: StreamHandlers = {},
  selectedModel?: string
): Promise<GeneratedProject> {
  let lastError: unknown = new Error("Failed to parse generated project JSON after retries");

  for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt++) {
    try {
      return parseGeneratedResponse(raw);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      if (attempt >= MAX_PARSE_ATTEMPTS) {
        break;
      }

      store.appendLog(
        runId,
        `[${timestamp()}] JSON parse attempt ${attempt}/${MAX_PARSE_ATTEMPTS} failed; requesting JSON fix from model…`
      );
      store.appendLog(runId, `[${timestamp()}] Parse error: ${message}`);

      raw = await fixInvalidJsonResponse(
        config,
        idea,
        raw,
        message,
        trackLlmUsage(store, tracker, runId, "json_fix", withModelAttemptLogs(store, runId, handlers)),
        { selectedModel }
      );
    }
  }

  throw lastError;
}

async function validateProjectWithRetries(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  idea: string,
  project: GeneratedProject,
  selectedModel?: string
): Promise<GeneratedProject> {
  store.appendLog(
    runId,
    `[${timestamp()}] Starting backend validation pipeline (lint → tests)…`
  );

  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
    try {
      await validateGeneratedProject(runId, project.files, (line) => {
        store.appendLog(runId, `[${timestamp()}] ${line}`);
      });
      return project;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt >= MAX_VALIDATION_ATTEMPTS) {
        throw error;
      }

      store.appendLog(
        runId,
        `[${timestamp()}] Validation attempt ${attempt}/${MAX_VALIDATION_ATTEMPTS} failed; requesting fixes from model…`
      );
      store.appendLog(runId, `[${timestamp()}] Validation error: ${message}`);

      let fixStreamChars = 0;
      const raw = await fixProjectFromValidationErrors(
        config,
        idea,
        project,
        message,
        trackLlmUsage(
          store,
          tracker,
          runId,
          "validation_fix",
          withModelAttemptLogs(store, runId, {
            onContent: (chunk) => {
              fixStreamChars += chunk.length;
              if (fixStreamChars % 500 < chunk.length) {
                store.appendLog(
                  runId,
                  `[${timestamp()}] Model fix stream… ${fixStreamChars} chars received`
                );
              }
            }
          })
        ),
        { selectedModel }
      );

      store.appendLog(runId, `[${timestamp()}] Parsing fixed JSON project payload…`);
      project = await parseProjectWithRetries(
        config,
        store,
        tracker,
        runId,
        idea,
        raw,
        {
          onContent: (chunk) => {
            fixStreamChars += chunk.length;
            if (fixStreamChars % 500 < chunk.length) {
              store.appendLog(
                runId,
                `[${timestamp()}] Model JSON fix stream… ${fixStreamChars} chars received`
              );
            }
          }
        },
        selectedModel
      );
      store.appendLog(
        runId,
        `[${timestamp()}] Fixed project summary: ${project.summary}`
      );
      store.appendLog(
        runId,
        `[${timestamp()}] Re-running validation (attempt ${attempt + 1}/${MAX_VALIDATION_ATTEMPTS})…`
      );
    }
  }

  return project;
}

export async function runGeneration(
  config: AppConfig,
  store: RunStore,
  runId: string,
  idea: string,
  selectedModel?: string
): Promise<void> {
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  let lastKnownFiles: Record<string, string> | undefined;
  try {
    store.setStatus(runId, "running");
    store.appendLog(runId, `[${timestamp()}] prism0 run ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Idea received: "${idea}"`);
    store.appendLog(
      runId,
      `[${timestamp()}] Using model ${selectedModel || config.openaiModel} at ${config.openaiBaseUrl}`
    );
    store.appendLog(
      runId,
      `[${timestamp()}] Configured model fallback order: ${config.openaiModels.join(" → ")}`
    );

    store.appendLog(runId, `[${timestamp()}] Building generation prompt with TDD requirements…`);
    store.appendLog(
      runId,
      `[${timestamp()}] Calling OpenAI-compatible chat completions API (streaming enabled)…`
    );

    let streamedChars = 0;
    let streamedReasoningChars = 0;
    let sawStreamActivity = false;

    const heartbeat = setInterval(() => {
      if (sawStreamActivity) return;
      store.appendLog(
        runId,
        `[${timestamp()}] Still waiting for model response (large models like Nemotron can take minutes, or the endpoint may be down)…`
      );
    }, 15_000);

    let raw: string;
    try {
      raw = await generateProjectFromIdea(
        config,
        idea,
        trackLlmUsage(
          store,
          tracker,
          runId,
          "generate",
          withModelAttemptLogs(store, runId, {
            onStreamOpen: () => {
              store.appendLog(
                runId,
                `[${timestamp()}] Model stream connected; waiting for first token…`
              );
            },
            onReasoning: (chunk) => {
              sawStreamActivity = true;
              streamedReasoningChars += chunk.length;
              if (streamedReasoningChars % 400 < chunk.length) {
                store.appendLog(
                  runId,
                  `[${timestamp()}] Model reasoning stream… ${streamedReasoningChars} chars so far`
                );
              }
            },
            onContent: (chunk) => {
              sawStreamActivity = true;
              streamedChars += chunk.length;
              if (streamedChars % 500 < chunk.length) {
                store.appendLog(
                  runId,
                  `[${timestamp()}] Model content stream… ${streamedChars} chars received`
                );
              }
            }
          })
        ),
        { selectedModel }
      );
    } finally {
      clearInterval(heartbeat);
    }

    store.appendLog(
      runId,
      `[${timestamp()}] Model response complete (${raw.length} chars total, ${streamedReasoningChars} reasoning chars)`
    );

    store.appendLog(runId, `[${timestamp()}] Parsing generated JSON project payload…`);
    let project = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      idea,
      raw,
      {
        onContent: (chunk) => {
          streamedChars += chunk.length;
          if (streamedChars % 500 < chunk.length) {
            store.appendLog(
              runId,
              `[${timestamp()}] Model JSON fix stream… ${streamedChars} chars received`
            );
          }
        }
      },
      selectedModel
    );
    store.appendLog(
      runId,
      `[${timestamp()}] Parsed project summary: ${project.summary}`
    );
    lastKnownFiles = project.files;
    store.appendLog(
      runId,
      `[${timestamp()}] Generated files: ${Object.keys(project.files).join(", ")}`
    );

    project = await validateProjectWithRetries(config, store, tracker, runId, idea, project, selectedModel);
    lastKnownFiles = project.files;

    store.appendLog(runId, `[${timestamp()}] All checks passed. Publishing files to editor/preview.`);
    store.complete(runId, project.files, project.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Run failed: ${message}`);
    if (lastKnownFiles) {
      store.setFiles(runId, lastKnownFiles);
    }
    store.fail(runId, message);
  }
}

export async function runFollowUp(
  config: AppConfig,
  store: RunStore,
  runId: string,
  idea: string,
  project: GeneratedProject,
  followUpPrompt: string,
  selectedModel?: string
): Promise<void> {
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  const augmentedIdea = `${idea}\n\nFollow-up request: ${followUpPrompt}`;
  let lastKnownFiles = project.files;

  try {
    store.setStatus(runId, "running");
    store.appendLog(runId, `[${timestamp()}] prism0 follow-up run ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Original app idea: "${idea}"`);
    store.appendLog(runId, `[${timestamp()}] Follow-up prompt: "${followUpPrompt}"`);
    store.appendLog(
      runId,
      `[${timestamp()}] Requesting updates from model ${selectedModel || config.openaiModel}…`
    );

    let followUpStreamChars = 0;
    const raw = await updateProjectFromFollowUp(
      config,
      idea,
      project,
      followUpPrompt,
      trackLlmUsage(
        store,
        tracker,
        runId,
        "follow_up",
        withModelAttemptLogs(store, runId, {
          onStreamOpen: () => {
            store.appendLog(runId, `[${timestamp()}] Model follow-up stream connected…`);
          },
          onContent: (chunk) => {
            followUpStreamChars += chunk.length;
            if (followUpStreamChars % 500 < chunk.length) {
              store.appendLog(
                runId,
                `[${timestamp()}] Model follow-up stream… ${followUpStreamChars} chars received`
              );
            }
          }
        })
      ),
      { selectedModel }
    );

    store.appendLog(runId, `[${timestamp()}] Parsing follow-up JSON project payload…`);
    let updatedProject = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      augmentedIdea,
      raw,
      {
        onContent: (chunk) => {
          followUpStreamChars += chunk.length;
          if (followUpStreamChars % 500 < chunk.length) {
            store.appendLog(
              runId,
              `[${timestamp()}] Model JSON fix stream… ${followUpStreamChars} chars received`
            );
          }
        }
      },
      selectedModel
    );
    store.appendLog(runId, `[${timestamp()}] Follow-up summary: ${updatedProject.summary}`);
    lastKnownFiles = updatedProject.files;

    updatedProject = await validateProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      augmentedIdea,
      updatedProject,
      selectedModel
    );

    store.appendLog(runId, `[${timestamp()}] Follow-up checks passed. Publishing updated files.`);
    store.complete(runId, updatedProject.files, updatedProject.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Follow-up failed: ${message}`);
    store.setFiles(runId, lastKnownFiles);
    store.fail(runId, message);
  }
}

export async function runRuntimeRepair(
  config: AppConfig,
  store: RunStore,
  runId: string,
  idea: string,
  project: GeneratedProject,
  runtimeError: string,
  selectedModel?: string
): Promise<void> {
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  let lastKnownFiles = project.files;
  try {
    store.setStatus(runId, "running");
    store.appendLog(runId, `[${timestamp()}] prism0 runtime repair ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Repairing app idea: "${idea}"`);
    store.appendLog(runId, `[${timestamp()}] Runtime error received: ${runtimeError}`);
    store.appendLog(
      runId,
      `[${timestamp()}] Requesting browser crash fixes from model ${selectedModel || config.openaiModel}…`
    );

    let fixStreamChars = 0;
    const raw = await fixProjectFromRuntimeError(
      config,
      idea,
      project,
      runtimeError,
      trackLlmUsage(
        store,
        tracker,
        runId,
        "runtime_fix",
        withModelAttemptLogs(store, runId, {
          onStreamOpen: () => {
            store.appendLog(runId, `[${timestamp()}] Model repair stream connected…`);
          },
          onContent: (chunk) => {
            fixStreamChars += chunk.length;
            if (fixStreamChars % 500 < chunk.length) {
              store.appendLog(
                runId,
                `[${timestamp()}] Model runtime fix stream… ${fixStreamChars} chars received`
              );
            }
          }
        })
      ),
      { selectedModel }
    );

    store.appendLog(runId, `[${timestamp()}] Parsing repaired JSON project payload…`);
    let repairedProject = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      idea,
      raw,
      {
        onContent: (chunk) => {
          fixStreamChars += chunk.length;
          if (fixStreamChars % 500 < chunk.length) {
            store.appendLog(
              runId,
              `[${timestamp()}] Model JSON fix stream… ${fixStreamChars} chars received`
            );
          }
        }
      },
      selectedModel
    );
    store.appendLog(
      runId,
      `[${timestamp()}] Runtime repair summary: ${repairedProject.summary}`
    );
    lastKnownFiles = repairedProject.files;

    repairedProject = await validateProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      idea,
      repairedProject,
      selectedModel
    );

    store.appendLog(runId, `[${timestamp()}] Runtime repair checks passed. Publishing fixed files.`);
    store.complete(runId, repairedProject.files, repairedProject.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Runtime repair failed: ${message}`);
    store.setFiles(runId, lastKnownFiles);
    store.fail(runId, message);
  }
}

export async function runValidationRepair(
  config: AppConfig,
  store: RunStore,
  runId: string,
  idea: string,
  project: GeneratedProject,
  validationError: string,
  selectedModel?: string
): Promise<void> {
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  let lastKnownFiles = project.files;
  try {
    store.setStatus(runId, "running");
    store.appendLog(runId, `[${timestamp()}] prism0 validation repair ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Repairing app idea: "${idea}"`);
    store.appendLog(runId, `[${timestamp()}] Validation error received: ${validationError}`);
    store.appendLog(
      runId,
      `[${timestamp()}] Requesting validation fixes from model ${selectedModel || config.openaiModel}…`
    );

    let fixStreamChars = 0;
    const raw = await fixProjectFromValidationErrors(
      config,
      idea,
      project,
      validationError,
      trackLlmUsage(
        store,
        tracker,
        runId,
        "validation_fix",
        withModelAttemptLogs(store, runId, {
          onStreamOpen: () => {
            store.appendLog(runId, `[${timestamp()}] Model validation repair stream connected…`);
          },
          onContent: (chunk) => {
            fixStreamChars += chunk.length;
            if (fixStreamChars % 500 < chunk.length) {
              store.appendLog(
                runId,
                `[${timestamp()}] Model validation fix stream… ${fixStreamChars} chars received`
              );
            }
          }
        })
      ),
      { selectedModel }
    );

    store.appendLog(runId, `[${timestamp()}] Parsing repaired JSON project payload…`);
    let repairedProject = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      idea,
      raw,
      {
        onContent: (chunk) => {
          fixStreamChars += chunk.length;
          if (fixStreamChars % 500 < chunk.length) {
            store.appendLog(
              runId,
              `[${timestamp()}] Model JSON fix stream… ${fixStreamChars} chars received`
            );
          }
        }
      },
      selectedModel
    );
    store.appendLog(
      runId,
      `[${timestamp()}] Validation repair summary: ${repairedProject.summary}`
    );
    lastKnownFiles = repairedProject.files;

    repairedProject = await validateProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      idea,
      repairedProject,
      selectedModel
    );

    store.appendLog(
      runId,
      `[${timestamp()}] Validation repair checks passed. Publishing fixed files.`
    );
    store.complete(runId, repairedProject.files, repairedProject.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Validation repair failed: ${message}`);
    store.setFiles(runId, lastKnownFiles);
    store.fail(runId, message);
  }
}

function withModelAttemptLogs(
  store: RunStore,
  runId: string,
  handlers: StreamHandlers = {}
): StreamHandlers {
  return {
    ...handlers,
    onModelAttempt: (model, attempt, totalAttempts) => {
      if (totalAttempts > 1) {
        store.appendLog(
          runId,
          `[${timestamp()}] Trying model ${model} (${attempt}/${totalAttempts})…`
        );
      }
    },
    onModelFallback: (failedModel, error, nextModel) => {
      store.appendLog(
        runId,
        `[${timestamp()}] Model ${failedModel} failed: ${error}. Trying fallback ${nextModel}…`
      );
    }
  };
}

function trackLlmUsage(
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  kind: Exclude<LlmUsageKind, "thinking">,
  handlers: StreamHandlers = {}
): StreamHandlers {
  const callId = tracker.beginCall(kind);
  const publish = () => store.updateUsage(runId, tracker.snapshot());

  return {
    ...handlers,
    onStreamOpen: handlers.onStreamOpen,
    onReasoning: (chunk) => {
      tracker.recordOutputEstimate(callId, "thinking", estimateTokensFromText(chunk));
      publish();
      handlers.onReasoning?.(chunk);
    },
    onContent: (chunk) => {
      tracker.recordOutputEstimate(callId, kind, estimateTokensFromText(chunk));
      publish();
      handlers.onContent?.(chunk);
    },
    onUsage: (usage: LlmCompletionUsage) => {
      tracker.finalizeCall(callId, usage);
      publish();
      handlers.onUsage?.(usage);
    }
  };
}
