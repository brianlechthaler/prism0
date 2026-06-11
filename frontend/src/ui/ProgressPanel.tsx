import React, { useEffect, useMemo, useRef } from "react";
import type { RunStreams, RunUsageMetrics } from "../hooks/useGeneration";
import { UsageMetricsPanel } from "./UsageMetrics";

type ProgressPanelProps = {
  logs: string[];
  streams: RunStreams;
  usage?: RunUsageMetrics;
  placeholder?: string;
};

function useAutoScroll<T extends HTMLElement>(value: unknown) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current!.scrollTop = ref.current!.scrollHeight;
  }, [value]);
  return ref;
}

function splitValidationLogs(logs: string[]) {
  const activity: string[] = [];
  const validation: string[] = [];
  let yoloSkipped = false;

  for (const line of logs) {
    if (line.includes("YOLO mode: skipping validation harness")) {
      yoloSkipped = true;
      validation.push(line);
    } else if (
      line.includes("YOLO mode enabled for this run") ||
      line.includes("YOLO mode enabled for this follow-up")
    ) {
      yoloSkipped = true;
      activity.push(line);
    } else if (line.includes("[validation]") || line.includes("[eslint]") || line.includes("[vitest]")) {
      validation.push(line);
    } else {
      activity.push(line);
    }
  }

  return { activity, validation, yoloSkipped };
}

function StreamSection({
  title,
  text,
  emptyText,
  className = ""
}: {
  title: string;
  text: string;
  emptyText: string;
  className?: string;
}) {
  const ref = useAutoScroll<HTMLDivElement>(text);

  return (
    <div className={`logSection ${className}`.trim()}>
      <div className="logSectionTitle">{title}</div>
      <div className="log logStream" role="log" aria-live="polite" ref={ref}>
        {text || emptyText}
      </div>
    </div>
  );
}

export function ProgressPanel({ logs, streams, usage, placeholder }: ProgressPanelProps) {
  const { activity, validation, yoloSkipped } = useMemo(() => splitValidationLogs(logs), [logs]);
  const activityRef = useAutoScroll<HTMLDivElement>(activity.join("\n"));
  const validationRef = useAutoScroll<HTMLDivElement>(validation.join("\n"));
  const validationEmptyText = yoloSkipped
    ? "Validation skipped (YOLO mode). ESLint and Vitest were not run."
    : "ESLint and Vitest output from the backend validation pipeline will appear here.";

  return (
    <div className="progressPanel">
      <UsageMetricsPanel metrics={usage} />

      <StreamSection
        title="LLM thinking"
        text={streams.thinking}
        emptyText="Reasoning tokens from the model will appear here when available."
        className="logSectionThinking"
      />

      <StreamSection
        title="Generated code"
        text={streams.content}
        emptyText="The model's JSON/code output will stream here as it is generated."
        className="logSectionContent"
      />

      <div className="logSection">
        <div className="logSectionTitle">Validation harness</div>
        <div className="log logValidation" role="log" aria-live="polite" ref={validationRef}>
          {validation.length > 0 ? validation.join("\n") : validationEmptyText}
        </div>
      </div>

      <div className="logSection">
        <div className="logSectionTitle">Activity</div>
        <div className="log" role="log" aria-live="polite" ref={activityRef}>
          {activity.length > 0 ? activity.join("\n") : placeholder ?? "Waiting for progress…"}
        </div>
      </div>
    </div>
  );
}
