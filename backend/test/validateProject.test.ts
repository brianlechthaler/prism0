import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyHarnessConfigs,
  resolveExecuteCommand,
  resolveValidationOrchestration,
  runCommand,
  validateGeneratedProject,
  type ValidationDeps
} from "../src/validateProject.js";

function mockChild(exitCode: number, stdout = "", stderr = "") {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });

  return child;
}

function createDeps(overrides: Partial<ValidationDeps> = {}): ValidationDeps {
  const spawn = vi.fn();
  return {
    fs: {
      rm: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockResolvedValue(undefined),
      symlink: vi.fn().mockResolvedValue(undefined)
    },
    spawn,
    harnessRoot: "/harness",
    ...overrides
  };
}

const files = {
  "index.html": "<html></html>",
  "index.js": "export const ok = true;",
  "styles.css": "body {}",
  "index.test.js": "import { ok } from './index.js';",
  "package.json": '{"type":"module","scripts":{"test":"vitest run","lint":"eslint ."}}'
};

describe("validateGeneratedProject", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes files and orchestrates lint/test commands", async () => {
    const deps = createDeps({
      copyConfigs: vi.fn().mockResolvedValue(undefined),
      execute: vi
        .fn()
        .mockResolvedValueOnce("lint ok")
        .mockResolvedValueOnce("tests ok")
    });

    const logs: string[] = [];
    const result = await validateGeneratedProject("run-1", files, (line) => logs.push(line), deps);

    expect(deps.fs.writeFile).toHaveBeenCalledTimes(5);
    expect(deps.copyConfigs).toHaveBeenCalled();
    expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ lintOutput: "lint ok", testOutput: "tests ok" });
    expect(logs.some((l) => l.includes("Validation finished successfully"))).toBe(true);
  });
});

describe("resolveValidationOrchestration", () => {
  it("falls back to default helpers", () => {
    const deps = createDeps();
    const resolved = resolveValidationOrchestration(deps);
    expect(resolved.copyConfigs).toBe(copyHarnessConfigs);
    expect(resolved.execute).toBe(runCommand);
  });
});

describe("resolveExecuteCommand", () => {
  it("returns injected execute helpers when provided", () => {
    const execute = vi.fn();
    expect(resolveExecuteCommand(createDeps({ execute }))).toBe(execute);
  });
});

describe("copyHarnessConfigs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links existing harness node_modules", async () => {
    const deps = createDeps();
    const logs: string[] = [];
    await copyHarnessConfigs("/harness/runs/r", (line) => logs.push(line), deps);
    expect(deps.fs.symlink).toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Linked validation harness node_modules"))).toBe(true);
  });

  it("installs dependencies when harness modules are missing", async () => {
    const deps = createDeps({
      fs: {
        rm: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        copyFile: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockRejectedValue(new Error("missing")),
        symlink: vi.fn().mockResolvedValue(undefined)
      },
      execute: vi.fn().mockResolvedValue("installed")
    });

    await copyHarnessConfigs("/harness/runs/r", () => {}, deps);
    expect(deps.execute).toHaveBeenCalledWith(
      "npm",
      ["install"],
      "/harness/runs/r",
      expect.any(Function),
      deps.spawn
    );
  });
});

describe("runCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles processes without stdout/stderr streams", async () => {
    const spawn = vi.fn().mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(runCommand("npm", ["run", "lint"], "/tmp", () => {}, spawn)).resolves.toBe("");
  });

  it("returns stdout/stderr on success", async () => {
    const spawn = vi.fn().mockReturnValue(mockChild(0, "ok", "warn"));
    const lines: string[] = [];
    const output = await runCommand("npm", ["run", "lint"], "/tmp", (line) => lines.push(line), spawn);
    expect(output).toContain("ok");
    expect(output).toContain("warn");
    expect(lines.some((l) => l.includes("[stdout]"))).toBe(true);
    expect(lines.some((l) => l.includes("[stderr]"))).toBe(true);
  });

  it("throws when command exits non-zero", async () => {
    const spawn = vi.fn().mockReturnValue(mockChild(1, "", "lint failed"));
    await expect(runCommand("npm", ["run", "lint"], "/tmp", () => {}, spawn)).rejects.toThrow(
      /lint failed/
    );
  });

  it("enables shell mode on windows", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const spawn = vi.fn().mockReturnValue(mockChild(0, "ok"));
    await runCommand("npm", ["run", "lint"], "/tmp", () => {}, spawn);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ shell: true, cwd: "/tmp" });
    platform.mockRestore();
  });

  it("rejects when spawn fails to start", async () => {
    const spawn = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    await expect(runCommand("npm", ["run", "lint"], "/tmp", () => {}, spawn)).rejects.toThrow(
      /spawn failed/
    );
  });
});
