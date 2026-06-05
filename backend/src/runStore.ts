import { randomUUID } from "node:crypto";
import type { GenerationRun, RunStatus, SseMessage } from "./types.js";

type Subscriber = (message: SseMessage) => void;

type InternalRun = GenerationRun & {
  subscribers: Set<Subscriber>;
};

export class RunStore {
  private runs = new Map<string, InternalRun>();

  create(idea: string): GenerationRun {
    const id = randomUUID();
    const run: InternalRun = {
      id,
      idea,
      status: "pending",
      logs: [],
      files: {},
      subscribers: new Set()
    };
    this.runs.set(id, run);
    return this.snapshot(run);
  }

  get(id: string): GenerationRun | undefined {
    const run = this.runs.get(id);
    return run ? this.snapshot(run) : undefined;
  }

  subscribe(id: string, subscriber: Subscriber): () => void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run not found: ${id}`);

    for (const line of run.logs) {
      subscriber({ type: "log", line });
    }

    if (run.status === "done") {
      subscriber({ type: "done", files: run.files });
    } else if (run.status === "error") {
      subscriber({ type: "error", message: run.error || "Unknown error" });
    } else {
      run.subscribers.add(subscriber);
    }

    return () => run.subscribers.delete(subscriber);
  }

  appendLog(id: string, line: string): void {
    const run = this.require(id);
    run.logs.push(line);
    this.broadcast(run, { type: "log", line });
  }

  setStatus(id: string, status: RunStatus): void {
    this.require(id).status = status;
  }

  setFiles(id: string, files: Record<string, string>): void {
    this.require(id).files = files;
  }

  complete(id: string, files: Record<string, string>): void {
    const run = this.require(id);
    run.status = "done";
    run.files = files;
    this.broadcast(run, { type: "done", files });
    run.subscribers.clear();
  }

  fail(id: string, message: string): void {
    const run = this.require(id);
    run.status = "error";
    run.error = message;
    this.broadcast(run, { type: "error", message });
    run.subscribers.clear();
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

  private snapshot(run: InternalRun): GenerationRun {
    return {
      id: run.id,
      idea: run.idea,
      status: run.status,
      logs: [...run.logs],
      files: { ...run.files },
      error: run.error
    };
  }
}
