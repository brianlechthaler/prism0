import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (spawnMock.getMockImplementation()) {
        return spawnMock(...args);
      }
      return actual.spawn(...args);
    }
  };
});

import { runSandboxedValidationCommand } from "../src/validateProject.js";

describe("runSandboxedValidationCommand spawn failures", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("rejects when the child process fails to spawn", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      });
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    await expect(
      runSandboxedValidationCommand("ignored", process.cwd(), () => {})
    ).rejects.toThrow("spawn failed");
  });

  it("rejects sandboxed shell commands with unknown exit codes", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      });
      queueMicrotask(() => child.emit("close", null));
      return child;
    });

    await expect(runSandboxedValidationCommand("ignored", process.cwd(), () => {})).rejects.toThrow(
      /exit unknown/
    );
  });

  it("cleans up abort listeners when spawn fails with a signal", async () => {
    const controller = new AbortController();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      });
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    await expect(
      runSandboxedValidationCommand("ignored", process.cwd(), () => {}, undefined, controller.signal)
    ).rejects.toThrow("spawn failed");
  });

  it("cleans up abort listeners when sandboxed commands exit non-zero", async () => {
    const controller = new AbortController();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      });
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });

    await expect(
      runSandboxedValidationCommand("ignored", process.cwd(), () => {}, undefined, controller.signal)
    ).rejects.toThrow(/exit 1/);
  });
});
