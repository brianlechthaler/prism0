import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";

export type LlmUsageKind =
  | "generate"
  | "follow_up"
  | "thinking"
  | "json_fix"
  | "validation_fix"
  | "runtime_fix"
  | "context_compress";

export type LlmUsageBucket = {
  kind: LlmUsageKind;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type RunUsageMetrics = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindowTokens: number;
  contextUsedTokens: number;
  contextUsedPercent: number;
  outputTokensPerSecond: number;
  buckets: LlmUsageBucket[];
};

export type StreamChannel = "thinking" | "content";

export type RunStreams = Record<StreamChannel, string>;

export const emptyRunStreams = (): RunStreams => ({ thinking: "", content: "" });

export type GenerationState =
  | { kind: "idle" }
  | {
      kind: "generating";
      runId: string;
      logs: string[];
      streams: RunStreams;
      usage?: RunUsageMetrics;
    }
  | {
      kind: "paused";
      runId: string;
      logs: string[];
      streams: RunStreams;
      usage?: RunUsageMetrics;
      files?: Record<string, string>;
    }
  | {
      kind: "ready";
      runId: string;
      logs: string[];
      streams: RunStreams;
      files: Record<string, string>;
      usage?: RunUsageMetrics;
    }
  | {
      kind: "error";
      message: string;
      logs: string[];
      streams: RunStreams;
      runId?: string;
      files?: Record<string, string>;
      repairable?: boolean;
      usage?: RunUsageMetrics;
    };

type SsePayload =
  | { type: "log"; line: string }
  | { type: "stream"; channel: StreamChannel; chunk: string }
  | { type: "usage"; metrics: RunUsageMetrics }
  | { type: "done"; files: Record<string, string> }
  | {
      type: "error";
      message: string;
      runId?: string;
      files?: Record<string, string>;
      repairable?: boolean;
    }
  | { type: "stopped"; runId: string }
  | { type: "paused"; runId: string };

export type ModelOptionsState = {
  enabled: boolean;
  defaultModel: string;
  models: string[];
  yoloModeEnabled: boolean;
  isLoading: boolean;
  error?: string;
};

type ModelOptionsResponse = {
  enabled: boolean;
  defaultModel: string;
  models: string[];
  yoloModeEnabled: boolean;
};

export type GenerationRequestOptions = {
  yolo?: boolean;
  projectId?: string;
};

function requestBodyWithModel<T extends Record<string, unknown>>(
  body: T,
  model?: string,
  options?: GenerationRequestOptions
): T & { model?: string; yolo?: boolean; projectId?: string } {
  return {
    ...body,
    ...(model ? { model } : {}),
    ...(options?.yolo ? { yolo: true } : {}),
    ...(options?.projectId ? { projectId: options.projectId } : {})
  };
}

export function appendLogLine(state: GenerationState, line: string): GenerationState {
  if (
    state.kind === "generating" ||
    state.kind === "paused" ||
    state.kind === "ready" ||
    state.kind === "error"
  ) {
    return { ...state, logs: [...state.logs, line] };
  }
  return state;
}

export function appendStreamChunk(
  state: GenerationState,
  channel: StreamChannel,
  chunk: string
): GenerationState {
  if (
    state.kind === "generating" ||
    state.kind === "paused" ||
    state.kind === "ready" ||
    state.kind === "error"
  ) {
    return {
      ...state,
      streams: {
        ...state.streams,
        [channel]: state.streams[channel] + chunk
      }
    };
  }
  return state;
}

export function completeGeneration(
  state: GenerationState,
  runId: string,
  files: Record<string, string>
): Extract<GenerationState, { kind: "ready" }> {
  const logs = "logs" in state ? state.logs : [];
  const streams = "streams" in state ? state.streams : emptyRunStreams();
  const usage = "usage" in state ? state.usage : undefined;
  return { kind: "ready", runId, logs: [...logs, "Ready."], streams, files, usage };
}

export function failGeneration(
  state: GenerationState,
  message: string,
  details?: { runId?: string; files?: Record<string, string>; repairable?: boolean }
): Extract<GenerationState, { kind: "error" }> {
  const logs = "logs" in state ? state.logs : [];
  const streams = "streams" in state ? state.streams : emptyRunStreams();
  const usage = "usage" in state ? state.usage : undefined;
  const runId = details?.runId ?? ("runId" in state ? state.runId : undefined);
  const files =
    details?.files ??
    (state.kind === "ready" || state.kind === "paused" ? state.files : undefined) ??
    (state.kind === "error" ? state.files : undefined);
  const repairable =
    details?.repairable ??
    (files && Object.keys(files).length > 0 ? true : undefined);
  return {
    kind: "error",
    message,
    logs,
    streams,
    usage,
    ...(runId ? { runId } : {}),
    ...(files ? { files } : {}),
    ...(repairable ? { repairable: true } : {})
  };
}

export function extractValidationErrorFromLogs(logs: string[], fallbackMessage: string): string {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const match = logs[index].match(/Validation error: (.+)/);
    if (match?.[1]) return match[1];
  }
  return fallbackMessage;
}

export function isYoloRun(logs: string[]): boolean {
  return logs.some(
    (line) =>
      line.includes("YOLO mode: skipping validation harness") ||
      line.includes("YOLO mode enabled for this run") ||
      line.includes("YOLO mode enabled for this follow-up")
  );
}

export function applyUsageUpdate(
  state: GenerationState,
  usage: RunUsageMetrics
): GenerationState {
  if (
    state.kind === "generating" ||
    state.kind === "paused" ||
    state.kind === "ready" ||
    state.kind === "error"
  ) {
    return { ...state, usage };
  }
  return state;
}

export function beginGeneratingState(
  previous: GenerationState,
  initial: {
    runId: string;
    logs: string[];
  },
  options: { preserveProgress?: boolean } = {}
): Extract<GenerationState, { kind: "generating" }> {
  const preserve = options.preserveProgress ?? false;
  const priorLogs = "logs" in previous ? previous.logs : [];
  const priorStreams = "streams" in previous ? previous.streams : emptyRunStreams();
  const priorUsage = "usage" in previous ? previous.usage : undefined;

  return {
    kind: "generating",
    runId: initial.runId,
    logs: preserve ? [...priorLogs, ...initial.logs] : initial.logs,
    streams: preserve ? priorStreams : emptyRunStreams(),
    ...(preserve && priorUsage ? { usage: priorUsage } : {})
  };
}

export function useModelOptions() {
  const [modelOptions, setModelOptions] = useState<ModelOptionsState>({
    enabled: false,
    defaultModel: "",
    models: [],
    yoloModeEnabled: false,
    isLoading: true
  });

  useEffect(() => {
    let isActive = true;

    async function loadModelOptions() {
      try {
        const res = await apiFetch("/api/models");
        if (!res.ok) {
          throw new Error(await res.text());
        }

        const json = (await res.json()) as ModelOptionsResponse;
        if (!isActive) return;
        setModelOptions({
          enabled: json.enabled,
          defaultModel: json.defaultModel,
          models: json.models,
          yoloModeEnabled: json.yoloModeEnabled,
          isLoading: false
        });
      } catch (error) {
        if (!isActive) return;
        setModelOptions({
          enabled: false,
          defaultModel: "",
          models: [],
          yoloModeEnabled: false,
          isLoading: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    void loadModelOptions();
    return () => {
      isActive = false;
    };
  }, []);

  return modelOptions;
}

export function pauseGenerationState(
  state: GenerationState,
  runId: string
): Extract<GenerationState, { kind: "paused" }> {
  const logs = "logs" in state ? state.logs : [];
  const streams = "streams" in state ? state.streams : emptyRunStreams();
  const usage = "usage" in state ? state.usage : undefined;
  const files = state.kind === "error" ? state.files : undefined;
  return {
    kind: "paused",
    runId,
    logs: [...logs, "Paused."],
    streams,
    usage,
    ...(files ? { files } : {})
  };
}

export function useGeneration() {
  const [state, setState] = useState<GenerationState>({ kind: "idle" });
  const stateRef = useRef(state);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastSubmittedIdeaRef = useRef<string>("");

  stateRef.current = state;

  useEffect(() => {
    return () => eventSourceRef.current?.close();
  }, []);

  const connectToRun = useCallback((runId: string) => {
    eventSourceRef.current?.close();
    const es = new EventSource(`/api/generate/${encodeURIComponent(runId)}/events`);
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as SsePayload;

      if (msg.type === "log") {
        setState((s) => appendLogLine(s, msg.line));
      } else if (msg.type === "stream") {
        setState((s) => appendStreamChunk(s, msg.channel, msg.chunk));
      } else if (msg.type === "usage") {
        setState((s) => applyUsageUpdate(s, msg.metrics));
      } else if (msg.type === "done") {
        setState((s) => completeGeneration(s, runId, msg.files));
        es.close();
      } else if (msg.type === "stopped") {
        setState({ kind: "idle" });
        es.close();
      } else if (msg.type === "paused") {
        setState((s) => pauseGenerationState(s, runId));
      } else {
        setState((s) =>
          failGeneration(s, msg.message, {
            runId: msg.runId ?? runId,
            files: msg.files,
            repairable: msg.repairable
          })
        );
        es.close();
      }
    };

    es.onerror = () => {
      setState((s) => {
        if (s.kind !== "generating") return s;
        return failGeneration(s, "Lost connection to live progress. Check backend logs and retry.");
      });
      es.close();
    };
  }, []);

  const requestRunControl = useCallback(async (runId: string, action: "stop" | "pause" | "resume") => {
    const res = await fetch(`/api/generate/${encodeURIComponent(runId)}/${action}`, {
      method: "POST"
    });
    if (!res.ok) {
      const message = await res.text();
      setState((current) => failGeneration(current, message, { runId }));
    }
    return res.ok;
  }, []);

  const stop = useCallback(
    async (runId: string) => {
      await requestRunControl(runId, "stop");
      eventSourceRef.current?.close();
    },
    [requestRunControl]
  );

  const pause = useCallback(
    async (runId: string) => {
      await requestRunControl(runId, "pause");
    },
    [requestRunControl]
  );

  const resume = useCallback(
    async (runId: string) => {
      setState((current) =>
        beginGeneratingState(
          current,
          { runId, logs: ["Resuming generation…"] },
          { preserveProgress: true }
        )
      );
      const ok = await requestRunControl(runId, "resume");
      if (!ok) return;
      connectToRun(runId);
    },
    [connectToRun, requestRunControl]
  );

  const start = useCallback(
    async (idea: string, model?: string, options?: GenerationRequestOptions) => {
      lastSubmittedIdeaRef.current = idea;
      eventSourceRef.current?.close();
      setState(beginGeneratingState({ kind: "idle" }, { runId: "", logs: ["Starting…"] }));

      const res = await apiFetch("/api/generate", {
        method: "POST",
        json: requestBodyWithModel({ idea }, model, options)
      });

      if (!res.ok) {
        const message = await res.text();
        setState((current) => failGeneration(current, message));
        return;
      }

      const json = (await res.json()) as { runId: string };
      const runId = json.runId;
      setState(beginGeneratingState({ kind: "idle" }, {
        runId,
        logs: ["Run created.", "Connecting to live progress…"]
      }));
      connectToRun(runId);
    },
    [connectToRun]
  );

  const restart = useCallback(
    async (idea: string, model?: string, options?: GenerationRequestOptions) => {
      const current = stateRef.current;
      const activeRunId = "runId" in current ? current.runId : undefined;
      if (activeRunId && (current.kind === "generating" || current.kind === "paused")) {
        await stop(activeRunId);
      }

      await start(idea, model, options);
    },
    [start, stop]
  );

  const repair = useCallback(
    async (runId: string, error: string, model?: string) => {
      eventSourceRef.current?.close();
      setState((current) =>
        beginGeneratingState(
          current,
          { runId: "", logs: ["Requesting LLM repair for generated app crash…"] },
          { preserveProgress: true }
        )
      );

      const res = await apiFetch(`/api/generate/${encodeURIComponent(runId)}/fix`, {
        method: "POST",
        json: requestBodyWithModel({ error }, model)
      });

      if (!res.ok) {
        const message = await res.text();
        setState((current) => failGeneration(current, message, { runId }));
        return;
      }

      const json = (await res.json()) as { runId: string };
      const repairRunId = json.runId;
      setState((current) =>
        beginGeneratingState(
          current,
          { runId: repairRunId, logs: ["Repair run created.", "Connecting to live progress…"] },
          { preserveProgress: true }
        )
      );
      connectToRun(repairRunId);
    },
    [connectToRun]
  );

  const followUp = useCallback(
    async (runId: string, prompt: string, model?: string, options?: GenerationRequestOptions) => {
      eventSourceRef.current?.close();
      setState((current) =>
        beginGeneratingState(
          current,
          { runId: "", logs: ["Requesting follow-up changes…"] },
          { preserveProgress: true }
        )
      );

      const res = await apiFetch(`/api/generate/${encodeURIComponent(runId)}/follow-up`, {
        method: "POST",
        json: requestBodyWithModel({ prompt }, model, options)
      });

      if (!res.ok) {
        const message = await res.text();
        setState((current) => failGeneration(current, message, { runId }));
        return;
      }

      const json = (await res.json()) as { runId: string };
      const followUpRunId = json.runId;
      setState((current) =>
        beginGeneratingState(
          current,
          { runId: followUpRunId, logs: ["Follow-up run created.", "Connecting to live progress…"] },
          { preserveProgress: true }
        )
      );
      connectToRun(followUpRunId);
    },
    [connectToRun]
  );

  const repairValidation = useCallback(
    async (runId: string, error: string, model?: string) => {
      eventSourceRef.current?.close();
      setState((current) =>
        beginGeneratingState(
          current,
          { runId: "", logs: ["Requesting LLM repair for validation errors…"] },
          { preserveProgress: true }
        )
      );

      const res = await apiFetch(`/api/generate/${encodeURIComponent(runId)}/validation-fix`, {
        method: "POST",
        json: requestBodyWithModel({ error }, model)
      });

      if (!res.ok) {
        const message = await res.text();
        setState((current) => failGeneration(current, message, { runId }));
        return;
      }

      const json = (await res.json()) as { runId: string };
      const repairRunId = json.runId;
      setState((current) =>
        beginGeneratingState(
          current,
          { runId: repairRunId, logs: ["Validation repair run created.", "Connecting to live progress…"] },
          { preserveProgress: true }
        )
      );
      connectToRun(repairRunId);
    },
    [connectToRun]
  );

  return {
    state,
    start,
    stop,
    pause,
    resume,
    restart,
    repair,
    repairValidation,
    followUp
  };
}
