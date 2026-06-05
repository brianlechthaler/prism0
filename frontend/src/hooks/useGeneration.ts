import { useCallback, useEffect, useRef, useState } from "react";

export type GenerationState =
  | { kind: "idle" }
  | { kind: "generating"; runId: string; logs: string[] }
  | { kind: "ready"; runId: string; logs: string[]; files: Record<string, string> }
  | { kind: "error"; message: string; logs: string[] };

type SsePayload =
  | { type: "log"; line: string }
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
  return { kind: "ready", runId, logs: [...logs, "Ready."], files };
}

export function failGeneration(
  state: GenerationState,
  message: string
): Extract<GenerationState, { kind: "error" }> {
  const logs = "logs" in state ? state.logs : [];
  return { kind: "error", message, logs };
}

export function useGeneration() {
  const [state, setState] = useState<GenerationState>({ kind: "idle" });
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => eventSourceRef.current?.close();
  }, []);

  const start = useCallback(async (idea: string) => {
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
    setState({ kind: "generating", runId, logs: ["Run created.", "Connecting to live progress…"] });

    const es = new EventSource(`/api/generate/${encodeURIComponent(runId)}/events`);
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as SsePayload;

      if (msg.type === "log") {
        setState((s) => appendLogLine(s, msg.line));
      } else if (msg.type === "done") {
        setState((s) => completeGeneration(s, runId, msg.files));
        es.close();
      } else {
        setState((s) => failGeneration(s, msg.message));
        es.close();
      }
    };
  }, []);

  return { state, start };
}
