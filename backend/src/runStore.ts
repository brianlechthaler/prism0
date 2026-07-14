import { randomUUID } from "node:crypto";
import { sanitizeClientError } from "./security.js";
import type {
  GenerationRun,
  RunCheckpoint,
  RunStatus,
  RunUsageMetrics,
  SseMessage,
  StreamChannel
} from "./types.js";

type Subscriber = (message: SseMessage) => void;

function emptyStreams(): GenerationRun["streams"] {
  return { thinking: "", content: "" };
}

type InternalRun = GenerationRun & {
  ownerUserId?: string;
  subscribers: Set<Subscriber>;
  createdAt: number;
  updatedAt: number;
  abortController?: AbortController;
};

export type RunStoreOptions = {
  maxRuns?: number;
  now?: () => number;
};

export class RunStore {
  private runs = new Map<string, InternalRun>();
  private readonly maxRuns: number;
  private readonly now: () => number;

  constructor(options: RunStoreOptions = {}) {
    this.maxRuns = options.maxRuns ?? 100;
    this.now = options.now ?? Date.now;
  }

  create(idea: string, ownerUserId?: string): GenerationRun {
    const id = randomUUID();
    const now = this.now();
    const run: InternalRun = {
      id,
      idea,
      status: "pending",
      logs: [],
      streams: emptyStreams(),
      files: {},
      ownerUserId,
      subscribers: new Set(),
      createdAt: now,
      updatedAt: now
    };
    this.runs.set(id, run);
    this.pruneTerminalRuns();
    return this.snapshot(run);
  }

  get(id: string): GenerationRun | undefined {
    const run = this.runs.get(id);
    return run ? this.snapshot(run) : undefined;
  }

  isOwnedBy(id: string, userId: string | undefined): boolean {
    const run = this.runs.get(id);
    if (!run?.ownerUserId) return false;
    return run.ownerUserId === userId;
  }

  getOwnerUserId(id: string): string | undefined {
    return this.runs.get(id)?.ownerUserId;
  }

  activeCount(): number {
    return [...this.runs.values()].filter(
      (run) => run.status === "pending" || run.status === "running"
    ).length;
  }

  isControllable(id: string): boolean {
    const run = this.runs.get(id);
    return run?.status === "pending" || run?.status === "running";
  }

  isResumable(id: string): boolean {
    return this.runs.get(id)?.status === "paused";
  }

  attachAbortController(id: string): AbortController {
    const run = this.require(id);
    if (run.abortController && !run.abortController.signal.aborted) {
      return run.abortController;
    }
    const controller = new AbortController();
    run.abortController = controller;
    return controller;
  }

  getAbortSignal(id: string): AbortSignal | undefined {
    return this.runs.get(id)?.abortController?.signal;
  }

  clearAbortController(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.abortController = undefined;
  }

  stop(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || !this.isControllable(id)) return false;
    if (run.abortController) {
      run.abortController.abort("stop");
    } else {
      this.markStopped(id);
    }
    return true;
  }

  pause(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || !this.isControllable(id)) return false;
    if (run.abortController) {
      run.abortController.abort("pause");
    } else {
      this.markPaused(id, {
        kind: "generate",
        stage: "llm",
        idea: run.idea,
        contextState: {}
      });
    }
    return true;
  }

  markStopped(id: string): void {
    const run = this.require(id);
    run.status = "cancelled";
    run.updatedAt = this.now();
    run.abortController = undefined;
    this.broadcast(run, { type: "stopped", runId: run.id });
    run.subscribers.clear();
    this.pruneTerminalRuns();
  }

  markPaused(id: string, checkpoint: RunCheckpoint): void {
    const run = this.require(id);
    run.status = "paused";
    run.checkpoint = checkpoint;
    run.updatedAt = this.now();
    run.abortController = undefined;
    this.broadcast(run, { type: "paused", runId: run.id });
  }

  getCheckpoint(id: string): RunCheckpoint | undefined {
    return this.runs.get(id)?.checkpoint;
  }

  resume(id: string): RunCheckpoint | undefined {
    const run = this.runs.get(id);
    if (!run || run.status !== "paused" || !run.checkpoint) return undefined;
    run.status = "running";
    run.updatedAt = this.now();
    return run.checkpoint;
  }

  subscribe(id: string, subscriber: Subscriber): () => void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run not found: ${id}`);

    for (const line of run.logs) {
      subscriber({ type: "log", line });
    }

    for (const channel of ["thinking", "content"] as const) {
      const text = run.streams[channel];
      if (text) {
        subscriber({ type: "stream", channel, chunk: text });
      }
    }

    if (run.usage) {
      subscriber({ type: "usage", metrics: run.usage });
    }

    if (run.status === "done") {
      subscriber({ type: "done", files: run.files });
    } else if (run.status === "error") {
      subscriber(this.errorMessage(run));
    } else if (run.status === "cancelled") {
      subscriber({ type: "stopped", runId: run.id });
    } else if (run.status === "paused") {
      subscriber({ type: "paused", runId: run.id });
      run.subscribers.add(subscriber);
    } else {
      run.subscribers.add(subscriber);
    }

    return () => run.subscribers.delete(subscriber);
  }

  appendLog(id: string, line: string): void {
    const run = this.require(id);
    run.logs.push(line);
    run.updatedAt = this.now();
    this.broadcast(run, { type: "log", line });
  }

  appendStream(id: string, channel: StreamChannel, chunk: string): void {
    if (!chunk) return;
    const run = this.require(id);
    run.streams[channel] += chunk;
    run.updatedAt = this.now();
    this.broadcast(run, { type: "stream", channel, chunk });
  }

  setStatus(id: string, status: RunStatus): void {
    const run = this.require(id);
    run.status = status;
    run.updatedAt = this.now();
  }

  setFiles(id: string, files: Record<string, string>): void {
    const run = this.require(id);
    run.files = files;
    run.updatedAt = this.now();
  }

  updateUsage(id: string, usage: RunUsageMetrics): void {
    const run = this.require(id);
    run.usage = this.cloneUsage(usage);
    run.updatedAt = this.now();
    this.broadcast(run, { type: "usage", metrics: run.usage });
  }

  complete(id: string, files: Record<string, string>, summary?: string): void {
    const run = this.require(id);
    run.status = "done";
    run.files = files;
    if (summary !== undefined) {
      run.summary = summary;
    }
    run.updatedAt = this.now();
    this.broadcast(run, { type: "done", files });
    run.subscribers.clear();
    this.pruneTerminalRuns();
  }

  fail(id: string, message: string): void {
    const run = this.require(id);
    run.status = "error";
    run.error = message;
    run.updatedAt = this.now();
    this.broadcast(run, this.errorMessage(run));
    run.subscribers.clear();
    this.pruneTerminalRuns();
  }

  private errorMessage(run: InternalRun): Extract<SseMessage, { type: "error" }> {
    const repairable = Object.keys(run.files).length > 0;
    return {
      type: "error",
      message: sanitizeClientError(run.error || "Unknown error"),
      runId: run.id,
      ...(repairable ? { files: { ...run.files }, repairable: true } : {})
    };
  }

  private require(id: string): InternalRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  private broadcast(run: InternalRun, message: SseMessage): void {
    for (const subscriber of run.subscribers) {
      subscriber(message);
    }
  }

  private pruneTerminalRuns(): void {
    if (this.runs.size <= this.maxRuns) return;

    const terminalRuns = [...this.runs.values()]
      .filter(
        (run) =>
          run.status === "done" || run.status === "error" || run.status === "cancelled"
      )
      .sort((a, b) => a.updatedAt - b.updatedAt);

    for (const run of terminalRuns) {
      if (this.runs.size <= this.maxRuns) break;
      this.runs.delete(run.id);
    }
  }

  private snapshot(run: InternalRun): GenerationRun {
    return {
      id: run.id,
      idea: run.idea,
      status: run.status,
      logs: [...run.logs],
      streams: { ...run.streams },
      files: { ...run.files },
      summary: run.summary,
      usage: run.usage ? this.cloneUsage(run.usage) : undefined,
      error: run.error,
      checkpoint: run.checkpoint ? { ...run.checkpoint, contextState: { ...run.checkpoint.contextState } } : undefined
    };
  }

  private cloneUsage(usage: RunUsageMetrics): RunUsageMetrics {
    return {
      ...usage,
      buckets: usage.buckets.map((bucket) => ({ ...bucket }))
    };
  }
}
