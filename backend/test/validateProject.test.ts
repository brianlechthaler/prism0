import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyHarnessConfigs,
  createValidationEnv,
  resolveExecuteCommand,
  resolveValidationOrchestration,
  runOpencodeValidationCommand,
  runSandboxedValidationCommand,
  validateGeneratedProject,
  type ValidationDeps
} from "../src/validateProject.js";

const config = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  openaiModels: ["m"],
  modelPickerEnabled: false,
  yoloModeEnabled: false,
  host: "127.0.0.1",
  port: 8787,
  requestTimeoutMs: 120_000,
  contextWindowTokens: 128_000,
  contextCompressThreshold: 0.9,
  maxRuns: 100,
  maxActiveRuns: 5,
  generationRateLimitWindowMs: 60_000,
  generationRateLimitMax: 10,
  trustProxy: false
};

function createDeps(overrides: Partial<ValidationDeps> = {}): ValidationDeps {
  return {
    fs: {
      rm: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockResolvedValue(undefined),
      symlink: vi.fn().mockResolvedValue(undefined)
    },
    harnessRoot: "/harness",
    config,
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
    const result = await validateGeneratedProject(
      "run-1",
      files,
      (line) => logs.push(line),
      deps,
      undefined,
      config
    );

    expect(deps.fs.writeFile).toHaveBeenCalledTimes(5);
    expect(deps.copyConfigs).toHaveBeenCalled();
    expect(deps.execute).toHaveBeenCalledWith(
      `${process.execPath} node_modules/eslint/bin/eslint.js .`,
      "/harness/runs/run-1",
      expect.any(Function),
      config,
      undefined
    );
    expect(deps.execute).toHaveBeenCalledWith(
      `${process.execPath} node_modules/vitest/vitest.mjs run`,
      "/harness/runs/run-1",
      expect.any(Function),
      config,
      undefined
    );
    expect(result).toEqual({ lintOutput: "lint ok", testOutput: "tests ok" });
    expect(logs.some((l) => l.includes("Validation finished successfully"))).toBe(true);
    expect(logs.some((l) => l.includes("via OpenCode"))).toBe(true);
  });

  it("prefixes eslint and vitest command output in logs", async () => {
    const deps = createDeps({
      copyConfigs: vi.fn().mockResolvedValue(undefined),
      execute: vi
        .fn()
        .mockImplementationOnce(async (_cmd, _cwd, onLog) => {
          onLog("lint passed");
          return "lint ok";
        })
        .mockImplementationOnce(async (_cmd, _cwd, onLog) => {
          onLog("tests passed");
          return "tests ok";
        })
    });

    const logs: string[] = [];
    await validateGeneratedProject("run-1", files, (line) => logs.push(line), deps, undefined, config);

    expect(logs.some((l) => l.includes("[eslint] lint passed"))).toBe(true);
    expect(logs.some((l) => l.includes("[vitest] tests passed"))).toBe(true);
  });

  it("rejects unsafe generated filenames before writing files", async () => {
    const deps = createDeps({
      copyConfigs: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue("ok")
    });

    await expect(
      validateGeneratedProject("run-1", { "../escape.js": "x" }, () => {}, deps, undefined, config)
    ).rejects.toThrow(/unsafe/);
    expect(deps.fs.writeFile).not.toHaveBeenCalled();
  });

  it("runs all validation commands and aggregates failures", async () => {
    const deps = createDeps({
      copyConfigs: vi.fn().mockResolvedValue(undefined),
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error("Command failed (eslint), exit non-zero:\nunused var"))
        .mockRejectedValueOnce("assertion failed")
    });

    await expect(
      validateGeneratedProject("run-1", files, () => {}, deps, undefined, config)
    ).rejects.toThrow(/ESLint failed:[\s\S]*Vitest failed:[\s\S]*assertion failed/);
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it("requires AppConfig when config is not injected through deps", async () => {
    const deps = createDeps({ config: undefined });
    await expect(
      validateGeneratedProject("run-1", files, () => {}, deps)
    ).rejects.toThrow(/AppConfig is required/);
  });
});

describe("resolveValidationOrchestration", () => {
  it("falls back to default helpers", () => {
    const deps = createDeps();
    const resolved = resolveValidationOrchestration(deps);
    expect(resolved.copyConfigs).toBe(copyHarnessConfigs);
    expect(resolved.execute).toBe(runSandboxedValidationCommand);
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
      "npm ci --ignore-scripts --no-audit --no-fund",
      "/harness",
      expect.any(Function),
      config
    );
    expect(deps.fs.symlink).toHaveBeenCalledWith(
      "/harness/node_modules",
      "/harness/runs/r/node_modules",
      "dir"
    );
  });

  it("retries harness dependency install before failing", async () => {
    const deps = createDeps({
      fs: {
        rm: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        copyFile: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockRejectedValue(new Error("missing")),
        symlink: vi.fn().mockResolvedValue(undefined)
      },
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValueOnce("installed")
    });
    const logs: string[] = [];

    await copyHarnessConfigs("/harness/runs/r", (line) => logs.push(line), deps);

    expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes("retrying"))).toBe(true);
  });

  it("fails after exhausting harness dependency install retries", async () => {
    const deps = createDeps({
      fs: {
        rm: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        copyFile: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockRejectedValue(new Error("missing")),
        symlink: vi.fn().mockResolvedValue(undefined)
      },
      execute: vi.fn().mockRejectedValue("install failed")
    });

    await expect(copyHarnessConfigs("/harness/runs/r", () => {}, deps)).rejects.toBe("install failed");
    expect(deps.execute).toHaveBeenCalledTimes(3);
  });

  it("requires AppConfig when installing missing harness dependencies", async () => {
    const deps = createDeps({
      config: undefined,
      fs: {
        rm: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        copyFile: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockRejectedValue(new Error("missing")),
        symlink: vi.fn().mockResolvedValue(undefined)
      }
    });

    await expect(copyHarnessConfigs("/harness/runs/r", () => {}, deps)).rejects.toThrow(
      /AppConfig is required to install validation harness dependencies/
    );
  });
});

describe("runOpencodeValidationCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to runOpencodeShell and wraps failures", async () => {
    const shell = vi.spyOn(await import("../src/opencodeService.js"), "runOpencodeShell");
    shell.mockResolvedValue("ok");

    const output = await runOpencodeValidationCommand("echo hi", "/tmp", () => {}, config);
    expect(output).toBe("ok");
    expect(shell).toHaveBeenCalledWith(config, "echo hi", "/tmp", expect.any(Function), undefined);
  });

  it("rethrows pause and stop errors unchanged", async () => {
    const { RunPausedError, RunStoppedError } = await import("../src/runControl.js");
    const shell = vi.spyOn(await import("../src/opencodeService.js"), "runOpencodeShell");
    shell.mockRejectedValueOnce(new RunPausedError());
    shell.mockRejectedValueOnce(new RunStoppedError());

    await expect(runOpencodeValidationCommand("echo hi", "/tmp", () => {}, config)).rejects.toBeInstanceOf(
      RunPausedError
    );
    await expect(runOpencodeValidationCommand("echo hi", "/tmp", () => {}, config)).rejects.toBeInstanceOf(
      RunStoppedError
    );
  });

  it("wraps generic shell failures with command context", async () => {
    const shell = vi.spyOn(await import("../src/opencodeService.js"), "runOpencodeShell");
    shell.mockRejectedValue(new Error("boom"));

    await expect(runOpencodeValidationCommand("echo hi", "/tmp", () => {}, config)).rejects.toThrow(
      /Command failed \(echo hi\)/
    );
  });

  it("wraps non-error shell failures with command context", async () => {
    const shell = vi.spyOn(await import("../src/opencodeService.js"), "runOpencodeShell");
    shell.mockRejectedValue("plain failure");

    await expect(runOpencodeValidationCommand("echo hi", "/tmp", () => {}, config)).rejects.toThrow(
      /plain failure/
    );
  });

  it("runs sandboxed shell commands with filtered environment", async () => {
    const logs: string[] = [];
    const result = await runSandboxedValidationCommand(
      `${process.execPath} -e "console.log('sandbox-ok')"`,
      process.cwd(),
      (line) => logs.push(line)
    );
    expect(result).toContain("sandbox-ok");
    expect(logs.join("\n")).toContain("sandbox-ok");
  });

  it("rejects aborted sandboxed shell commands", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSandboxedValidationCommand("sleep 5", process.cwd(), () => {}, undefined, controller.signal)
    ).rejects.toThrow(/stopped/i);
  });

  it("aborts in-flight sandboxed shell commands", async () => {
    const controller = new AbortController();
    const promise = runSandboxedValidationCommand(
      process.platform === "win32" ? "timeout /t 5" : "sleep 2",
      process.cwd(),
      () => {},
      undefined,
      controller.signal
    );
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/stopped/i);
  });

  it("captures stderr output from sandboxed shell commands", async () => {
    const logs: string[] = [];
    const result = await runSandboxedValidationCommand(
      `${process.execPath} -e "console.error('stderr-only')"`,
      process.cwd(),
      (line) => logs.push(line)
    );
    expect(result).toContain("stderr-only");
    expect(logs.join("\n")).toContain("stderr-only");
  });

  it("rejects sandboxed shell commands that exit non-zero", async () => {
    await expect(
      runSandboxedValidationCommand(`${process.execPath} -e "process.exit(2)"`, process.cwd(), () => {})
    ).rejects.toThrow(/exit 2/);
  });
});

describe("createValidationEnv", () => {
  it("keeps only non-secret process environment needed for tools", () => {
    expect(
      createValidationEnv({
        PATH: "/bin",
        HOME: "/home/test",
        OPENAI_API_KEY: "secret",
        NPM_TOKEN: "token"
      })
    ).toEqual({ HOME: "/home/test", PATH: "/bin" });
  });
});
