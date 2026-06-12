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
import { RunPausedError, RunStoppedError, throwIfAborted } from "./runControl.js";
import type { RunStore } from "./runStore.js";
import type {
  GeneratedProject,
  LlmCompletionUsage,
  LlmUsageKind,
  RunCheckpoint,
  RunContextState
} from "./types.js";
import { estimateTokensFromText, RunUsageTracker } from "./usageTracker.js";
import { validateGeneratedProject } from "./validateProject.js";

function timestamp(): string {
  return new Date().toISOString();
}

function beginControlledRun(store: RunStore, runId: string): AbortSignal {
  store.setStatus(runId, "running");
  const existing = store.getAbortSignal(runId);
  if (existing) return existing;
  return store.attachAbortController(runId).signal;
}

function enrichCheckpointOnPause(
  store: RunStore,
  runId: string,
  checkpoint: RunCheckpoint
): RunCheckpoint {
  if (checkpoint.stage === "llm" && !checkpoint.raw) {
    const partial = store.get(runId)?.streams.content;
    if (partial) {
      return { ...checkpoint, raw: partial };
    }
  }
  return checkpoint;
}

function handleControlError(
  store: RunStore,
  runId: string,
  checkpoint: RunCheckpoint,
  error: unknown
): boolean {
  if (error instanceof RunPausedError) {
    store.appendLog(runId, `[${timestamp()}] Run paused; context retained for resume.`);
    store.markPaused(runId, enrichCheckpointOnPause(store, runId, checkpoint));
    return true;
  }
  if (error instanceof RunStoppedError) {
    store.appendLog(runId, `[${timestamp()}] Run stopped by user.`);
    store.markStopped(runId);
    return true;
  }
  return false;
}

function llmOptions(selectedModel: string | undefined, signal: AbortSignal) {
  return { selectedModel, signal };
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
  contextState: RunContextState = {},
  signal?: AbortSignal
): Promise<{ project: GeneratedProject; idea: string; contextState: RunContextState }> {
  let currentIdea = idea;
  let currentContextState = contextState;
  let lastError: unknown = new Error("Failed to parse generated project JSON after retries");

  for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
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
        { selectedModel, contextSummary: currentContextState.contextSummary, signal }
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
  contextState: RunContextState = {},
  signal?: AbortSignal
): Promise<{ project: GeneratedProject; idea: string; contextState: RunContextState }> {
  store.appendLog(
    runId,
    `[${timestamp()}] Starting backend validation pipeline (lint → tests)…`
  );

  let currentIdea = idea;
  let currentProject = project;
  let currentContextState = contextState;

  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    try {
      await validateGeneratedProject(
        runId,
        currentProject.files,
        (line) => {
          store.appendLog(runId, `[${timestamp()}] [validation] ${line}`);
        },
        undefined,
        signal
      );
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

      try {
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
          { selectedModel, signal }
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
          currentContextState,
          signal
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
      } catch (fixError) {
        const fixMessage = fixError instanceof Error ? fixError.message : String(fixError);
        store.appendLog(
          runId,
          `[${timestamp()}] Validation fix attempt ${attempt}/${MAX_VALIDATION_ATTEMPTS} failed: ${fixMessage}`
        );
        store.appendLog(
          runId,
          `[${timestamp()}] Retrying validation with another fix attempt…`
        );
      }
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
  options: GenerationOptions = {},
  signal?: AbortSignal
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
    contextState,
    signal
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
  const checkpoint: RunCheckpoint = {
    kind: "generate",
    stage: "llm",
    idea,
    selectedModel,
    skipValidation: options.skipValidation,
    contextState: {}
  };
  const signal = beginControlledRun(store, runId);
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  let lastKnownFiles: Record<string, string> | undefined;

  try {
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

    const project = await executeGeneratePipeline(
      config,
      store,
      tracker,
      runId,
      checkpoint,
      signal,
      options
    );
    lastKnownFiles = project.files;

    store.appendLog(
      runId,
      options.skipValidation
        ? `[${timestamp()}] Skipping validation (YOLO mode). Publishing files to editor/preview.`
        : `[${timestamp()}] All checks passed. Publishing files to editor/preview.`
    );
    store.complete(runId, project.files, project.summary);
  } catch (error) {
    if (handleControlError(store, runId, checkpoint, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Run failed: ${message}`);
    const files = lastKnownFiles ?? checkpoint.project?.files;
    if (files) {
      store.setFiles(runId, files);
    }
    store.fail(runId, message);
  }
}

async function executeGeneratePipeline(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  checkpoint: RunCheckpoint,
  signal: AbortSignal,
  options: GenerationOptions,
  resumeFrom?: Pick<RunCheckpoint, "stage" | "raw" | "project" | "contextState">
): Promise<GeneratedProject> {
  let raw = resumeFrom?.raw;
  let project = resumeFrom?.project;
  let currentIdea = checkpoint.idea;
  let contextState = resumeFrom?.contextState ?? checkpoint.contextState;

  if (!resumeFrom || resumeFrom.stage === "llm") {
    checkpoint.stage = "llm";
    store.appendLog(runId, `[${timestamp()}] Building generation prompt with TDD requirements…`);
    store.appendLog(
      runId,
      `[${timestamp()}] Calling OpenAI-compatible chat completions API (streaming enabled)…`
    );

    let sawStreamActivity = false;
    const heartbeat = setInterval(() => {
      if (sawStreamActivity) return;
      store.appendLog(
        runId,
        `[${timestamp()}] Still waiting for model response (large models like Nemotron can take minutes, or the endpoint may be down)…`
      );
    }, 15_000);

    try {
      raw = await generateProjectFromIdea(
        config,
        checkpoint.idea,
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
        llmOptions(checkpoint.selectedModel, signal)
      );
    } finally {
      clearInterval(heartbeat);
    }

    const streamedReasoningChars = store.get(runId)!.streams.thinking.length;
    store.appendLog(
      runId,
      `[${timestamp()}] Model response complete (${raw.length} chars total, ${streamedReasoningChars} reasoning chars)`
    );
    checkpoint.raw = raw;
  }

  if (!resumeFrom || resumeFrom.stage === "llm" || resumeFrom.stage === "parse") {
    if (!raw) {
      throw new Error("Missing model response for parse stage");
    }
    checkpoint.stage = "parse";
    store.appendLog(runId, `[${timestamp()}] Parsing generated JSON project payload…`);
    const parsed = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      currentIdea,
      raw,
      createLlmStreamHandlers(store, runId),
      checkpoint.selectedModel,
      project,
      contextState,
      signal
    );
    project = parsed.project;
    currentIdea = parsed.idea;
    contextState = parsed.contextState;
    checkpoint.project = project;
    checkpoint.contextState = contextState;
    store.appendLog(runId, `[${timestamp()}] Parsed project summary: ${project.summary}`);
    store.appendLog(
      runId,
      `[${timestamp()}] Generated files: ${Object.keys(project.files).join(", ")}`
    );
    logParsedProjectFiles(store, runId, project.files);
  }

  if (!project) {
    throw new Error("Missing parsed project for validation stage");
  }
  checkpoint.stage = "validate";
  const validated = await maybeValidateProject(
    config,
    store,
    tracker,
    runId,
    currentIdea,
    project,
    checkpoint.selectedModel,
    contextState,
    options,
    signal
  );
  checkpoint.project = validated.project;
  checkpoint.contextState = validated.contextState;
  return validated.project;
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
  const augmentedIdea = `${idea}\n\nFollow-up request: ${followUpPrompt}`;
  const checkpoint: RunCheckpoint = {
    kind: "follow_up",
    stage: "llm",
    idea: augmentedIdea,
    selectedModel,
    skipValidation: options.skipValidation,
    contextState: {},
    sourceProject: project,
    followUpPrompt
  };
  const signal = beginControlledRun(store, runId);
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  let lastKnownFiles = project.files;

  try {
    store.appendLog(runId, `[${timestamp()}] prism0 follow-up run ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Original app idea: "${idea}"`);
    store.appendLog(runId, `[${timestamp()}] Follow-up prompt: "${followUpPrompt}"`);
    if (options.skipValidation) {
      store.appendLog(
        runId,
        `[${timestamp()}] YOLO mode enabled for this follow-up — validation harness will be skipped.`
      );
    }

    const updatedProject = await executeFollowUpPipeline(
      config,
      store,
      tracker,
      runId,
      checkpoint,
      signal,
      idea,
      project,
      followUpPrompt,
      options
    );
    lastKnownFiles = updatedProject.files;

    store.appendLog(
      runId,
      options.skipValidation
        ? `[${timestamp()}] Follow-up validation skipped (YOLO mode). Publishing updated files.`
        : `[${timestamp()}] Follow-up checks passed. Publishing updated files.`
    );
    store.complete(runId, updatedProject.files, updatedProject.summary);
  } catch (error) {
    if (handleControlError(store, runId, checkpoint, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Follow-up failed: ${message}`);
    store.setFiles(runId, lastKnownFiles);
    store.fail(runId, message);
  }
}

async function executeFollowUpPipeline(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  checkpoint: RunCheckpoint,
  signal: AbortSignal,
  idea: string,
  sourceProject: GeneratedProject,
  followUpPrompt: string,
  options: GenerationOptions,
  resumeFrom?: Pick<RunCheckpoint, "stage" | "raw" | "project" | "contextState">
): Promise<GeneratedProject> {
  const augmentedIdea = checkpoint.idea;
  let raw = resumeFrom?.raw;
  let project = resumeFrom?.project;
  let currentIdea = augmentedIdea;
  let contextState = resumeFrom?.contextState ?? checkpoint.contextState;

  if (!resumeFrom || resumeFrom.stage === "llm") {
    checkpoint.stage = "llm";
    store.appendLog(
      runId,
      `[${timestamp()}] Requesting updates from model ${checkpoint.selectedModel || config.openaiModel}…`
    );
    raw = await updateProjectFromFollowUp(
      config,
      idea,
      sourceProject,
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
      llmOptions(checkpoint.selectedModel, signal)
    );
    checkpoint.raw = raw;
  }

  if (!resumeFrom || resumeFrom.stage === "llm" || resumeFrom.stage === "parse") {
    if (!raw) {
      throw new Error("Missing model response for parse stage");
    }
    checkpoint.stage = "parse";
    store.appendLog(runId, `[${timestamp()}] Parsing follow-up JSON project payload…`);
    const parsed = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      currentIdea,
      raw,
      createLlmStreamHandlers(store, runId),
      checkpoint.selectedModel,
      sourceProject,
      contextState,
      signal
    );
    project = parsed.project;
    currentIdea = parsed.idea;
    contextState = parsed.contextState;
    checkpoint.project = project;
    checkpoint.contextState = contextState;
    store.appendLog(runId, `[${timestamp()}] Follow-up summary: ${project.summary}`);
    logParsedProjectFiles(store, runId, project.files);
  }

  if (!project) {
    throw new Error("Missing parsed project for validation stage");
  }
  checkpoint.stage = "validate";
  const validated = await maybeValidateProject(
    config,
    store,
    tracker,
    runId,
    currentIdea,
    project,
    checkpoint.selectedModel,
    contextState,
    options,
    signal
  );
  checkpoint.project = validated.project;
  checkpoint.contextState = validated.contextState;
  return validated.project;
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
  const checkpoint: RunCheckpoint = {
    kind: "runtime_repair",
    stage: "llm",
    idea,
    selectedModel,
    contextState: {},
    sourceProject: project,
    runtimeError
  };
  const signal = beginControlledRun(store, runId);
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  let lastKnownFiles = project.files;

  try {
    store.appendLog(runId, `[${timestamp()}] prism0 runtime repair ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Repairing app idea: "${idea}"`);
    store.appendLog(runId, `[${timestamp()}] Runtime error received: ${runtimeError}`);

    const repairedProject = await executeRuntimeRepairPipeline(
      config,
      store,
      tracker,
      runId,
      checkpoint,
      signal,
      idea,
      project,
      runtimeError
    );
    lastKnownFiles = repairedProject.files;

    store.appendLog(runId, `[${timestamp()}] Runtime repair checks passed. Publishing fixed files.`);
    store.complete(runId, repairedProject.files, repairedProject.summary);
  } catch (error) {
    if (handleControlError(store, runId, checkpoint, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Runtime repair failed: ${message}`);
    store.setFiles(runId, lastKnownFiles);
    store.fail(runId, message);
  }
}

async function executeRuntimeRepairPipeline(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  checkpoint: RunCheckpoint,
  signal: AbortSignal,
  idea: string,
  sourceProject: GeneratedProject,
  runtimeError: string,
  resumeFrom?: Pick<RunCheckpoint, "stage" | "raw" | "project" | "contextState">
): Promise<GeneratedProject> {
  let raw = resumeFrom?.raw;
  let project = resumeFrom?.project;
  let currentIdea = idea;
  let contextState = resumeFrom?.contextState ?? checkpoint.contextState;

  if (!resumeFrom || resumeFrom.stage === "llm") {
    checkpoint.stage = "llm";
    store.appendLog(
      runId,
      `[${timestamp()}] Requesting browser crash fixes from model ${checkpoint.selectedModel || config.openaiModel}…`
    );
    raw = await fixProjectFromRuntimeError(
      config,
      idea,
      sourceProject,
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
      llmOptions(checkpoint.selectedModel, signal)
    );
    checkpoint.raw = raw;
  }

  if (!resumeFrom || resumeFrom.stage === "llm" || resumeFrom.stage === "parse") {
    if (!raw) {
      throw new Error("Missing model response for parse stage");
    }
    checkpoint.stage = "parse";
    store.appendLog(runId, `[${timestamp()}] Parsing repaired JSON project payload…`);
    const parsed = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      currentIdea,
      raw,
      createLlmStreamHandlers(store, runId),
      checkpoint.selectedModel,
      sourceProject,
      contextState,
      signal
    );
    project = parsed.project;
    currentIdea = parsed.idea;
    contextState = parsed.contextState;
    checkpoint.project = project;
    checkpoint.contextState = contextState;
    store.appendLog(runId, `[${timestamp()}] Runtime repair summary: ${project.summary}`);
    logParsedProjectFiles(store, runId, project.files);
  }

  if (!project) {
    throw new Error("Missing parsed project for validation stage");
  }
  checkpoint.stage = "validate";
  const validated = await validateProjectWithRetries(
    config,
    store,
    tracker,
    runId,
    currentIdea,
    project,
    checkpoint.selectedModel,
    contextState,
    signal
  );
  checkpoint.project = validated.project;
  checkpoint.contextState = validated.contextState;
  return validated.project;
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
  const checkpoint: RunCheckpoint = {
    kind: "validation_repair",
    stage: "llm",
    idea,
    selectedModel,
    contextState: {},
    sourceProject: project,
    validationError
  };
  const signal = beginControlledRun(store, runId);
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  let lastKnownFiles = project.files;

  try {
    store.appendLog(runId, `[${timestamp()}] prism0 validation repair ${runId} started`);
    store.appendLog(runId, `[${timestamp()}] Repairing app idea: "${idea}"`);
    store.appendLog(runId, `[${timestamp()}] Validation error received: ${validationError}`);

    const repairedProject = await executeValidationRepairPipeline(
      config,
      store,
      tracker,
      runId,
      checkpoint,
      signal,
      idea,
      project,
      validationError
    );
    lastKnownFiles = repairedProject.files;

    store.appendLog(
      runId,
      `[${timestamp()}] Validation repair checks passed. Publishing fixed files.`
    );
    store.complete(runId, repairedProject.files, repairedProject.summary);
  } catch (error) {
    if (handleControlError(store, runId, checkpoint, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Validation repair failed: ${message}`);
    store.setFiles(runId, lastKnownFiles);
    store.fail(runId, message);
  }
}

async function executeValidationRepairPipeline(
  config: AppConfig,
  store: RunStore,
  tracker: RunUsageTracker,
  runId: string,
  checkpoint: RunCheckpoint,
  signal: AbortSignal,
  idea: string,
  sourceProject: GeneratedProject,
  validationError: string,
  resumeFrom?: Pick<RunCheckpoint, "stage" | "raw" | "project" | "contextState">
): Promise<GeneratedProject> {
  let raw = resumeFrom?.raw;
  let project = resumeFrom?.project;
  let currentIdea = idea;
  let contextState = resumeFrom?.contextState ?? checkpoint.contextState;

  if (!resumeFrom || resumeFrom.stage === "llm") {
    checkpoint.stage = "llm";
    store.appendLog(
      runId,
      `[${timestamp()}] Requesting validation fixes from model ${checkpoint.selectedModel || config.openaiModel}…`
    );
    raw = await fixProjectFromValidationErrors(
      config,
      idea,
      sourceProject,
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
      llmOptions(checkpoint.selectedModel, signal)
    );
    checkpoint.raw = raw;
  }

  if (!resumeFrom || resumeFrom.stage === "llm" || resumeFrom.stage === "parse") {
    if (!raw) {
      throw new Error("Missing model response for parse stage");
    }
    checkpoint.stage = "parse";
    store.appendLog(runId, `[${timestamp()}] Parsing repaired JSON project payload…`);
    const parsed = await parseProjectWithRetries(
      config,
      store,
      tracker,
      runId,
      currentIdea,
      raw,
      createLlmStreamHandlers(store, runId),
      checkpoint.selectedModel,
      sourceProject,
      contextState,
      signal
    );
    project = parsed.project;
    currentIdea = parsed.idea;
    contextState = parsed.contextState;
    checkpoint.project = project;
    checkpoint.contextState = contextState;
    store.appendLog(runId, `[${timestamp()}] Validation repair summary: ${project.summary}`);
    logParsedProjectFiles(store, runId, project.files);
  }

  if (!project) {
    throw new Error("Missing parsed project for validation stage");
  }
  checkpoint.stage = "validate";
  const validated = await validateProjectWithRetries(
    config,
    store,
    tracker,
    runId,
    currentIdea,
    project,
    checkpoint.selectedModel,
    contextState,
    signal
  );
  checkpoint.project = validated.project;
  checkpoint.contextState = validated.contextState;
  return validated.project;
}

export async function resumeRun(
  config: AppConfig,
  store: RunStore,
  runId: string
): Promise<void> {
  const checkpoint = store.resume(runId);
  if (!checkpoint) {
    throw new Error("Run is not paused or has no checkpoint");
  }

  const signal = store.attachAbortController(runId).signal;
  const tracker = new RunUsageTracker(config.contextWindowTokens);
  const resumeFrom = {
    stage: checkpoint.stage,
    raw: checkpoint.raw,
    project: checkpoint.project,
    contextState: checkpoint.contextState
  };
  let lastKnownFiles = checkpoint.project?.files;

  try {
    store.appendLog(runId, `[${timestamp()}] Resuming run from ${checkpoint.stage} stage…`);

    let project: GeneratedProject;
    if (checkpoint.kind === "generate") {
      project = await executeGeneratePipeline(
        config,
        store,
        tracker,
        runId,
        checkpoint,
        signal,
        { skipValidation: checkpoint.skipValidation },
        resumeFrom
      );
    } else if (checkpoint.kind === "follow_up") {
      if (!checkpoint.sourceProject || !checkpoint.followUpPrompt) {
        throw new Error("Follow-up checkpoint is missing source project or prompt");
      }
      const originalIdea = checkpoint.idea.replace(
        `\n\nFollow-up request: ${checkpoint.followUpPrompt}`,
        ""
      );
      project = await executeFollowUpPipeline(
        config,
        store,
        tracker,
        runId,
        checkpoint,
        signal,
        originalIdea,
        checkpoint.sourceProject,
        checkpoint.followUpPrompt,
        { skipValidation: checkpoint.skipValidation },
        resumeFrom
      );
    } else if (checkpoint.kind === "runtime_repair") {
      if (!checkpoint.sourceProject || !checkpoint.runtimeError) {
        throw new Error("Runtime repair checkpoint is missing source project or error");
      }
      project = await executeRuntimeRepairPipeline(
        config,
        store,
        tracker,
        runId,
        checkpoint,
        signal,
        checkpoint.idea,
        checkpoint.sourceProject,
        checkpoint.runtimeError,
        resumeFrom
      );
    } else {
      if (!checkpoint.sourceProject || !checkpoint.validationError) {
        throw new Error("Validation repair checkpoint is missing source project or error");
      }
      project = await executeValidationRepairPipeline(
        config,
        store,
        tracker,
        runId,
        checkpoint,
        signal,
        checkpoint.idea,
        checkpoint.sourceProject,
        checkpoint.validationError,
        resumeFrom
      );
    }

    lastKnownFiles = project.files;
    store.appendLog(runId, `[${timestamp()}] Resumed run completed successfully.`);
    store.complete(runId, project.files, project.summary);
  } catch (error) {
    if (handleControlError(store, runId, checkpoint, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    store.appendLog(runId, `[${timestamp()}] Resumed run failed: ${message}`);
    if (lastKnownFiles) {
      store.setFiles(runId, lastKnownFiles);
    }
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
