import { useCallback, useEffect, useRef, useState } from "react";

export type LlmUsageKind =
  | "generate"
  | "follow_up"
  | "thinking"
  | "json_fix"
  | "validation_fix"
  | "runtime_fix";

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
    };

export type ModelOptionsState = {
  enabled: boolean;
  defaultModel: string;
  models: string[];
  isLoading: boolean;
  error?: string;
};

type ModelOptionsResponse = {
  enabled: boolean;
  defaultModel: string;
  models: string[];
};

function requestBodyWithModel<T extends Record<string, unknown>>(body: T, model?: string): string {
  return JSON.stringify(model ? { ...body, model } : body);
}

export function appendLogLine(state: GenerationState, line: string): GenerationState {
  if (state.kind === "generating" || state.kind === "ready" || state.kind === "error") {
    return { ...state, logs: [...state.logs, line] };
  }
  return state;
}

export function appendStreamChunk(
  state: GenerationState,
  channel: StreamChannel,
  chunk: string
): GenerationState {
  if (state.kind === "generating" || state.kind === "ready" || state.kind === "error") {
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
  return {
    kind: "error",
    message,
    logs,
    streams,
    usage,
    ...(runId ? { runId } : {}),
    ...(details?.files ? { files: details.files } : {}),
    ...(details?.repairable ? { repairable: true } : {})
  };
}

export function extractValidationErrorFromLogs(logs: string[], fallbackMessage: string): string {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const match = logs[index].match(/Validation error: (.+)/);
    if (match?.[1]) return match[1];
  }
  return fallbackMessage;
}

export function applyUsageUpdate(
  state: GenerationState,
  usage: RunUsageMetrics
): GenerationState {
  if (state.kind === "generating" || state.kind === "ready" || state.kind === "error") {
    return { ...state, usage };
  }
  return state;
}

export function useModelOptions() {
  const [modelOptions, setModelOptions] = useState<ModelOptionsState>({
    enabled: false,
    defaultModel: "",
    models: [],
    isLoading: true
  });

  useEffect(() => {
    let isActive = true;

    async function loadModelOptions() {
      try {
        const res = await fetch("/api/models");
        if (!res.ok) {
          throw new Error(await res.text());
        }

        const json = (await res.json()) as ModelOptionsResponse;
        if (!isActive) return;
        setModelOptions({
          enabled: json.enabled,
          defaultModel: json.defaultModel,
          models: json.models,
          isLoading: false
        });
      } catch (error) {
        if (!isActive) return;
        setModelOptions({
          enabled: false,
          defaultModel: "",
          models: [],
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

export function useGeneration() {
  const [state, setState] = useState<GenerationState>({ kind: "idle" });
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => eventSourceRef.current?.close();
  }, []);

  const connectToRun = useCallback((runId: string) => {
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
      setState((s) =>
        failGeneration(s, "Lost connection to live progress. Check backend logs and retry.")
      );
      es.close();
    };
  }, []);

  const start = useCallback(
    async (idea: string, model?: string) => {
      eventSourceRef.current?.close();
      setState({ kind: "generating", runId: "", logs: ["Starting…"], streams: emptyRunStreams() });

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBodyWithModel({ idea }, model)
      });

      if (!res.ok) {
        setState({ kind: "error", message: await res.text(), logs: [], streams: emptyRunStreams() });
        return;
      }

      const json = (await res.json()) as { runId: string };
      const runId = json.runId;
      setState({
        kind: "generating",
        runId,
        logs: ["Run created.", "Connecting to live progress…"],
        streams: emptyRunStreams()
      });
      connectToRun(runId);
    },
    [connectToRun]
  );

  const repair = useCallback(
    async (runId: string, error: string, model?: string) => {
      eventSourceRef.current?.close();
      setState({
        kind: "generating",
        runId: "",
        logs: ["Requesting LLM repair for generated app crash…"],
        streams: emptyRunStreams()
      });

      const res = await fetch(`/api/generate/${encodeURIComponent(runId)}/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBodyWithModel({ error }, model)
      });

      if (!res.ok) {
        setState({ kind: "error", message: await res.text(), logs: [], streams: emptyRunStreams() });
        return;
      }

      const json = (await res.json()) as { runId: string };
      const repairRunId = json.runId;
      setState({
        kind: "generating",
        runId: repairRunId,
        logs: ["Repair run created.", "Connecting to live progress…"],
        streams: emptyRunStreams()
      });
      connectToRun(repairRunId);
    },
    [connectToRun]
  );

  const followUp = useCallback(
    async (runId: string, prompt: string, model?: string) => {
      eventSourceRef.current?.close();
      setState({
        kind: "generating",
        runId: "",
        logs: ["Requesting follow-up changes…"],
        streams: emptyRunStreams()
      });

      const res = await fetch(`/api/generate/${encodeURIComponent(runId)}/follow-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBodyWithModel({ prompt }, model)
      });

      if (!res.ok) {
        setState({ kind: "error", message: await res.text(), logs: [], streams: emptyRunStreams() });
        return;
      }

      const json = (await res.json()) as { runId: string };
      const followUpRunId = json.runId;
      setState({
        kind: "generating",
        runId: followUpRunId,
        logs: ["Follow-up run created.", "Connecting to live progress…"],
        streams: emptyRunStreams()
      });
      connectToRun(followUpRunId);
    },
    [connectToRun]
  );

  const repairValidation = useCallback(
    async (runId: string, error: string, model?: string) => {
      eventSourceRef.current?.close();
      setState({
        kind: "generating",
        runId: "",
        logs: ["Requesting LLM repair for validation errors…"],
        streams: emptyRunStreams()
      });

      const res = await fetch(`/api/generate/${encodeURIComponent(runId)}/validation-fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBodyWithModel({ error }, model)
      });

      if (!res.ok) {
        setState({ kind: "error", message: await res.text(), logs: [], streams: emptyRunStreams() });
        return;
      }

      const json = (await res.json()) as { runId: string };
      const repairRunId = json.runId;
      setState({
        kind: "generating",
        runId: repairRunId,
        logs: ["Validation repair run created.", "Connecting to live progress…"],
        streams: emptyRunStreams()
      });
      connectToRun(repairRunId);
    },
    [connectToRun]
  );

  return { state, start, repair, repairValidation, followUp };
}
