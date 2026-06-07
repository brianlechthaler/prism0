import { useCallback, useEffect, useRef, useState } from "react";

export type LlmUsageKind = "generate" | "thinking" | "json_fix" | "validation_fix" | "runtime_fix";

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

export type GenerationState =
  | { kind: "idle" }
  | { kind: "generating"; runId: string; logs: string[]; usage?: RunUsageMetrics }
  | {
      kind: "ready";
      runId: string;
      logs: string[];
      files: Record<string, string>;
      usage?: RunUsageMetrics;
    }
  | { kind: "error"; message: string; logs: string[]; usage?: RunUsageMetrics };

type SsePayload =
  | { type: "log"; line: string }
  | { type: "usage"; metrics: RunUsageMetrics }
  | { type: "done"; files: Record<string, string> }
  | { type: "error"; message: string };

export function appendLogLine(state: GenerationState, line: string): GenerationState {
  if (state.kind === "generating" || state.kind === "ready" || state.kind === "error") {
    return { ...state, logs: [...state.logs, line] };
  }
  return state;
}

export function completeGeneration(
  state: GenerationState,
  runId: string,
  files: Record<string, string>
): Extract<GenerationState, { kind: "ready" }> {
  const logs = "logs" in state ? state.logs : [];
  const usage = "usage" in state ? state.usage : undefined;
  return { kind: "ready", runId, logs: [...logs, "Ready."], files, usage };
}

export function failGeneration(
  state: GenerationState,
  message: string
): Extract<GenerationState, { kind: "error" }> {
  const logs = "logs" in state ? state.logs : [];
  const usage = "usage" in state ? state.usage : undefined;
  return { kind: "error", message, logs, usage };
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
      } else if (msg.type === "usage") {
        setState((s) => applyUsageUpdate(s, msg.metrics));
      } else if (msg.type === "done") {
        setState((s) => completeGeneration(s, runId, msg.files));
        es.close();
      } else {
        setState((s) => failGeneration(s, msg.message));
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
    async (idea: string) => {
      eventSourceRef.current?.close();
      setState({ kind: "generating", runId: "", logs: ["Starting…"] });

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea })
      });

      if (!res.ok) {
        setState({ kind: "error", message: await res.text(), logs: [] });
        return;
      }

      const json = (await res.json()) as { runId: string };
      const runId = json.runId;
      setState({
        kind: "generating",
        runId,
        logs: ["Run created.", "Connecting to live progress…"]
      });
      connectToRun(runId);
    },
    [connectToRun]
  );

  const repair = useCallback(
    async (runId: string, error: string) => {
      eventSourceRef.current?.close();
      setState({
        kind: "generating",
        runId: "",
        logs: ["Requesting LLM repair for generated app crash…"]
      });

      const res = await fetch(`/api/generate/${encodeURIComponent(runId)}/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error })
      });

      if (!res.ok) {
        setState({ kind: "error", message: await res.text(), logs: [] });
        return;
      }

      const json = (await res.json()) as { runId: string };
      const repairRunId = json.runId;
      setState({
        kind: "generating",
        runId: repairRunId,
        logs: ["Repair run created.", "Connecting to live progress…"]
      });
      connectToRun(repairRunId);
    },
    [connectToRun]
  );

  return { state, start, repair };
}
