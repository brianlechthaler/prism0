export class RunStoppedError extends Error {
  constructor() {
    super("Generation stopped by user");
    this.name = "RunStoppedError";
  }
}

export class RunPausedError extends Error {
  constructor() {
    super("Generation paused by user");
    this.name = "RunPausedError";
  }
}

export type RunControlAction = "stop" | "pause";

export function abortReasonToAction(reason: unknown): RunControlAction {
  return reason === "pause" ? "pause" : "stop";
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortReasonToAction(signal.reason) === "pause"
    ? new RunPausedError()
    : new RunStoppedError();
}

export function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) {
    return new Promise(() => {});
  }

  if (signal.aborted) {
    return Promise.reject(
      abortReasonToAction(signal.reason) === "pause"
        ? new RunPausedError()
        : new RunStoppedError()
    );
  }

  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(
          abortReasonToAction(signal.reason) === "pause"
            ? new RunPausedError()
            : new RunStoppedError()
        );
      },
      { once: true }
    );
  });
}
