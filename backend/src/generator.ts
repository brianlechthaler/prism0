import type { AppConfig } from "./config.js";
import { maybeCompressRunContext } from "./contextCompression.js";
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
import type { GeneratedProject, LlmCompletionUsage, LlmUsageKind, RunContextState } from "./types.js";
import { estimateTokensFromText, RunUsageTracker } from "./usageTracker.js";
import { validateGeneratedProject } from "./validateProject.js";

function timestamp(): string {
  return new Date().toISOString();
}

function createLlmStreamHandlers(
  store: RunStore,
  runId: string,
  options: {
    onStreamActivity?: () => void;
    onStreamOpenMessage?: string;
  } = {}
): Pick<StreamHandlers, "onStreamOpen" | "onReasoning" | "onContent"> {
  return {
    onStreamOpen: () => {
      if (options.onStreamOpenMessage) {
        store.appendLog(runId, `[${timestamp()}] ${options.onStreamOpenMessage}`);
      }
    },
    onReasoning: (chunk) => {
      options.onStreamActivity?.();
      store.appendStream(runId, "thinking", chunk);
    },
    onContent: (chunk) => {
      options.onStreamActivity?.();
      store.appendStream(runId, "content", chunk);
    }
  };
}

function logParsedProjectFiles(
  store: RunStore,
  runId: string,
  files: Record<string, string>
): void {
  store.appendLog(runId, `[${timestamp()}] --- Parsed generated files ---`);
  for (const [filename, content] of Object.entries(files)) {
    store.appendLog(runId, `[${timestamp()}] ${filename} (${content.length} chars)`);
    store.appendStream(runId, "content", `\n\n=== ${filename} ===\n${content}\n`);
  }
}

async function parseProjectWithRetries(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  idea: string,
  raw: string,
  handlers: StreamHandlers = {},
  selectedModel?: string,
  project?: GeneratedProject,
  contextState: RunContextState = {}
): Promise<{ project: GeneratedProject; idea: string; contextState: RunContextState }> {
  let currentIdea = idea;
  let currentContextState = contextState;
  let lastError: unknown = new Error("Failed to parse generated project JSON after retries");

  for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt++) {
    try {
      return {
        project: parseGeneratedResponse(raw),
        idea: currentIdea,
        contextState: currentContextState
      };
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

      ({ idea: currentIdea, contextState: currentContextState } = await maybeCompressRunContext(
        config,
        store,
        tracker,
        runId,
        currentIdea,
        project,
        currentContextState,
        trackLlmUsage(store, tracker, runId, "context_compress", withModelAttemptLogs(store, runId, handlers)),
        selectedModel
      ));

      raw = await fixInvalidJsonResponse(
        config,
        currentIdea,
        raw,
        message,
        trackLlmUsage(store, tracker, runId, "json_fix", withModelAttemptLogs(store, runId, handlers)),
        { selectedModel, contextSummary: currentContextState.contextSummary }
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
  selectedModel?: string,
  contextState: RunContextState = {}
): Promise<{ project: GeneratedProject; idea: string; contextState: RunContextState }> {
  store.appendLog(
    runId,
    `[${timestamp()}] Starting backend validation pipeline (lint → tests)…`
  );

  let currentIdea = idea;
  let currentProject = project;
  let currentContextState = contextState;

  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
    try {
      await validateGeneratedProject(runId, currentProject.files, (line) => {
        store.appendLog(runId, `[${timestamp()}] [validation] ${line}`);
      });
      return { project: currentProject, idea: currentIdea, contextState: currentContextState };
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

      ({ idea: currentIdea, contextState: currentContextState } = await maybeCompressRunContext(
        config,
        store,
        tracker,
        runId,
        currentIdea,
        currentProject,
        currentContextState,
        trackLlmUsage(store, tracker, runId, "context_compress", withModelAttemptLogs(store, runId)),
        selectedModel
      ));

      const raw = await fixProjectFromValidationErrors(
        config,
        currentIdea,
        currentProject,
        message,
        trackLlmUsage(
          store,
          tracker,
          runId,
          "validation_fix",
          withModelAttemptLogs(
            store,
            runId,
            createLlmStreamHandlers(store, runId, {
              onStreamOpenMessage: "Model validation fix stream connected…"
            })
          )
        ),
        { selectedModel }
      );

      store.appendLog(runId, `[${timestamp()}] Parsing fixed JSON project payload…`);
      const parsed = await parseProjectWithRetries(
        config,
        store,
        tracker,
        runId,
        currentIdea,
        raw,
        createLlmStreamHandlers(store, runId),
        selectedModel,
        currentProject,
        currentContextState
      );
      currentProject = parsed.project;
      currentIdea = parsed.idea;
      currentContextState = parsed.contextState;
      store.appendLog(
        runId,
        `[${timestamp()}] Fixed project summary: ${currentProject.summary}`
      );
      store.appendLog(
        runId,
        `[${timestamp()}] Re-running validation (attempt ${attempt + 1}/${MAX_VALIDATION_ATTEMPTS})…`
      );
    }
  }

  return { project: currentProject, idea: currentIdea, contextState: currentContextState };
}

export const YOLO_SKIP_VALIDATION_LOG =
  "YOLO mode: skipping validation harness (lint/tests). Results may be unsafe or broken.";

export type GenerationOptions = {
  skipValidation?: boolean;
};

async function maybeValidateProject(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  idea: string,
  project: GeneratedProject,
  selectedModel: string | undefined,
  contextState: RunContextState,
  options: GenerationOptions = {}
): Promise<{ project: GeneratedProject; idea: string; contextState: RunContextState }> {
  if (options.skipValidation) {
    store.appendLog(runId, `[${timestamp()}] ${YOLO_SKIP_VALIDATION_LOG}`);
    return { project, idea, contextState };
  }

  return validateProjectWithRetries(
    config,
    store,
    tracker,
    runId,
    idea,
    project,
    selectedModel,
    contextState
  );
}

export async function runGeneration(
  config: AppConfig,
  store: RunStore,
  runId: string,
  idea: string,
  selectedModel?: string,
  options: GenerationOptions = {}
): Promise<void> {
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  let lastKnownFiles: Record<string, string> | undefined;
  try {
    store.setStatus(runId, "running");
    store.appendLog(runId, `[${timestamp()}] prism0 run ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Idea received: "${idea}"`);
    if (options.skipValidation) {
      store.appendLog(
        runId,
        `[${timestamp()}] YOLO mode enabled for this run — validation harness will be skipped.`
      );
    }
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
          withModelAttemptLogs(
            store,
            runId,
            createLlmStreamHandlers(store, runId, {
              onStreamOpenMessage: "Model stream connected; waiting for first token…",
              onStreamActivity: () => {
                sawStreamActivity = true;
              }
            })
          )
        ),
        { selectedModel }
      );
    } finally {
      clearInterval(heartbeat);
    }

    streamedReasoningChars = store.get(runId)!.streams.thinking.length;

    store.appendLog(
      runId,
      `[${timestamp()}] Model response complete (${raw.length} chars total, ${streamedReasoningChars} reasoning chars)`
    );

    store.appendLog(runId, `[${timestamp()}] Parsing generated JSON project payload…`);
    const parsed = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      idea,
      raw,
      createLlmStreamHandlers(store, runId),
      selectedModel
    );
    let project = parsed.project;
    store.appendLog(
      runId,
      `[${timestamp()}] Parsed project summary: ${project.summary}`
    );
    lastKnownFiles = project.files;
    store.appendLog(
      runId,
      `[${timestamp()}] Generated files: ${Object.keys(project.files).join(", ")}`
    );
    logParsedProjectFiles(store, runId, project.files);

    const validated = await maybeValidateProject(
      config,
      store,
      tracker,
      runId,
      parsed.idea,
      project,
      selectedModel,
      parsed.contextState,
      options
    );
    project = validated.project;
    lastKnownFiles = project.files;

    store.appendLog(
      runId,
      options.skipValidation
        ? `[${timestamp()}] Skipping validation (YOLO mode). Publishing files to editor/preview.`
        : `[${timestamp()}] All checks passed. Publishing files to editor/preview.`
    );
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
  selectedModel?: string,
  options: GenerationOptions = {}
): Promise<void> {
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  const augmentedIdea = `${idea}\n\nFollow-up request: ${followUpPrompt}`;
  let lastKnownFiles = project.files;

  try {
    store.setStatus(runId, "running");
    store.appendLog(runId, `[${timestamp()}] prism0 follow-up run ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Original app idea: "${idea}"`);
    store.appendLog(runId, `[${timestamp()}] Follow-up prompt: "${followUpPrompt}"`);
    if (options.skipValidation) {
      store.appendLog(
        runId,
        `[${timestamp()}] YOLO mode enabled for this follow-up — validation harness will be skipped.`
      );
    }
    store.appendLog(
      runId,
      `[${timestamp()}] Requesting updates from model ${selectedModel || config.openaiModel}…`
    );

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
        withModelAttemptLogs(
          store,
          runId,
          createLlmStreamHandlers(store, runId, {
            onStreamOpenMessage: "Model follow-up stream connected…"
          })
        )
      ),
      { selectedModel }
    );

    store.appendLog(runId, `[${timestamp()}] Parsing follow-up JSON project payload…`);
    const parsed = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      augmentedIdea,
      raw,
      createLlmStreamHandlers(store, runId),
      selectedModel,
      project
    );
    let updatedProject = parsed.project;
    store.appendLog(runId, `[${timestamp()}] Follow-up summary: ${updatedProject.summary}`);
    lastKnownFiles = updatedProject.files;
    logParsedProjectFiles(store, runId, updatedProject.files);

    const validated = await maybeValidateProject(
      config,
      store,
      tracker,
      runId,
      parsed.idea,
      updatedProject,
      selectedModel,
      parsed.contextState,
      options
    );
    updatedProject = validated.project;

    store.appendLog(
      runId,
      options.skipValidation
        ? `[${timestamp()}] Follow-up validation skipped (YOLO mode). Publishing updated files.`
        : `[${timestamp()}] Follow-up checks passed. Publishing updated files.`
    );
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
        withModelAttemptLogs(
          store,
          runId,
          createLlmStreamHandlers(store, runId, {
            onStreamOpenMessage: "Model repair stream connected…"
          })
        )
      ),
      { selectedModel }
    );

    store.appendLog(runId, `[${timestamp()}] Parsing repaired JSON project payload…`);
    const parsed = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      idea,
      raw,
      createLlmStreamHandlers(store, runId),
      selectedModel,
      project
    );
    let repairedProject = parsed.project;
    store.appendLog(
      runId,
      `[${timestamp()}] Runtime repair summary: ${repairedProject.summary}`
    );
    lastKnownFiles = repairedProject.files;
    logParsedProjectFiles(store, runId, repairedProject.files);

    const validated = await validateProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      parsed.idea,
      repairedProject,
      selectedModel,
      parsed.contextState
    );
    repairedProject = validated.project;

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
        withModelAttemptLogs(
          store,
          runId,
          createLlmStreamHandlers(store, runId, {
            onStreamOpenMessage: "Model validation repair stream connected…"
          })
        )
      ),
      { selectedModel }
    );

    store.appendLog(runId, `[${timestamp()}] Parsing repaired JSON project payload…`);
    const parsed = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      idea,
      raw,
      createLlmStreamHandlers(store, runId),
      selectedModel,
      project
    );
    let repairedProject = parsed.project;
    store.appendLog(
      runId,
      `[${timestamp()}] Validation repair summary: ${repairedProject.summary}`
    );
    lastKnownFiles = repairedProject.files;
    logParsedProjectFiles(store, runId, repairedProject.files);

    const validated = await validateProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      parsed.idea,
      repairedProject,
      selectedModel,
      parsed.contextState
    );
    repairedProject = validated.project;

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
