import type { AppConfig } from "./config.js";
import {
  createOpencodeClientHandle,
  getModelCandidates,
  runOpencodePrompt,
  type OpencodeStreamHandlers
} from "./opencodeService.js";
import {
  buildFixPrompt,
  buildFollowUpPrompt,
  buildGenerationPrompt,
  buildJsonFixPrompt,
  buildRuntimeFixPrompt
} from "./prompts.js";
import type { GeneratedProject, LlmUsageKind } from "./types.js";

export type StreamHandlers = OpencodeStreamHandlers;

export type ModelRequestOptions = {
  selectedModel?: string;
  signal?: AbortSignal;
};

type LlmCallKind = Exclude<LlmUsageKind, "thinking">;

export function createOpenAiClient(config: AppConfig) {
  return createOpencodeClientHandle(config);
}

export { getModelCandidates };

export async function streamProjectCompletion(
  config: AppConfig,
  prompt: string,
  kind: LlmCallKind,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return runOpencodePrompt(config, prompt, kind, handlers, options);
}

export async function generateProjectFromIdea(
  config: AppConfig,
  idea: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(config, buildGenerationPrompt(idea), "generate", handlers, options);
}

export async function updateProjectFromFollowUp(
  config: AppConfig,
  idea: string,
  project: GeneratedProject,
  followUpPrompt: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildFollowUpPrompt(idea, project, followUpPrompt),
    "follow_up",
    handlers,
    options
  );
}

export async function fixProjectFromValidationErrors(
  config: AppConfig,
  idea: string,
  project: GeneratedProject,
  validationError: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildFixPrompt(idea, project, validationError),
    "validation_fix",
    handlers,
    options
  );
}

export async function fixProjectFromRuntimeError(
  config: AppConfig,
  idea: string,
  project: GeneratedProject,
  runtimeError: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildRuntimeFixPrompt(idea, project, runtimeError),
    "runtime_fix",
    handlers,
    options
  );
}

export async function fixInvalidJsonResponse(
  config: AppConfig,
  idea: string,
  invalidResponse: string,
  parseError: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions & { contextSummary?: string } = {}
): Promise<string> {
  return streamProjectCompletion(
    config,
    buildJsonFixPrompt(idea, parseError, invalidResponse, options.contextSummary),
    "json_fix",
    handlers,
    options
  );
}

export async function compressRunContextWithModel(
  config: AppConfig,
  prompt: string,
  handlers: StreamHandlers = {},
  options: ModelRequestOptions = {}
): Promise<string> {
  return streamProjectCompletion(config, prompt, "context_compress", handlers, options);
}
