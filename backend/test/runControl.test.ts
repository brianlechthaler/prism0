import { describe, expect, it } from "vitest";
import {
  RunPausedError,
  RunStoppedError,
  abortReasonToAction,
  throwIfAborted,
  waitForAbort
} from "../src/runControl.js";

describe("runControl", () => {
  it("maps abort reasons to control actions", () => {
    expect(abortReasonToAction("pause")).toBe("pause");
    expect(abortReasonToAction("stop")).toBe("stop");
    expect(abortReasonToAction(undefined)).toBe("stop");
  });

  it("throws when an abort signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort("stop");
    expect(() => throwIfAborted(controller.signal)).toThrow(RunStoppedError);

    const pauseController = new AbortController();
    pauseController.abort("pause");
    expect(() => throwIfAborted(pauseController.signal)).toThrow(RunPausedError);
  });

  it("waits for abort signals and rejects with control errors", async () => {
    const controller = new AbortController();
    const pending = waitForAbort(controller.signal);
    controller.abort("pause");
    await expect(pending).rejects.toBeInstanceOf(RunPausedError);

    const stoppedController = new AbortController();
    stoppedController.abort("stop");
    await expect(waitForAbort(stoppedController.signal)).rejects.toBeInstanceOf(RunStoppedError);

    const pausedController = new AbortController();
    pausedController.abort("pause");
    await expect(waitForAbort(pausedController.signal)).rejects.toBeInstanceOf(RunPausedError);
  });

  it("waits indefinitely when no abort signal is provided", async () => {
    await expect(
      Promise.race([
        waitForAbort(undefined),
        new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 10))
      ])
    ).resolves.toBe("still-waiting");
  });

  it("rejects when abort listeners fire", async () => {
    const controller = new AbortController();
    const pending = waitForAbort(controller.signal);
    controller.abort("stop");
    await expect(pending).rejects.toThrow("Generation stopped by user");
  });
});
