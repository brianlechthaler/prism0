import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.js";
import { normalizeProjectFiles, resolveProjectFilePath } from "./fileSafety.js";
import { runOpencodeShell } from "./opencodeService.js";
import { RunPausedError, RunStoppedError, throwIfAborted } from "./runControl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HARNESS_ROOT = path.resolve(__dirname, "../validation-harness");
export const MAX_HARNESS_INSTALL_ATTEMPTS = 3;

export type ValidationResult = {
  lintOutput: string;
  testOutput: string;
};

export type ValidationDeps = {
  fs: Pick<typeof fs, "rm" | "mkdir" | "writeFile" | "copyFile" | "access" | "symlink">;
  harnessRoot: string;
  config?: AppConfig;
  copyConfigs?: (runDir: string, onLog: (line: string) => void, deps: ValidationDeps) => Promise<void>;
  execute?: (
    command: string,
    cwd: string,
    onLog: (line: string) => void,
    config: AppConfig,
    signal?: AbortSignal
  ) => Promise<string>;
};

const defaultDeps: ValidationDeps = {
  fs,
  harnessRoot: HARNESS_ROOT
};

export function resolveValidationOrchestration(deps: ValidationDeps) {
  return {
    copyConfigs: deps.copyConfigs ?? copyHarnessConfigs,
    execute: resolveExecuteCommand(deps)
  };
}

export function resolveExecuteCommand(deps: ValidationDeps) {
  return deps.execute ?? runOpencodeValidationCommand;
}

export async function validateGeneratedProject(
  runId: string,
  files: Record<string, string>,
  onLog: (line: string) => void,
  deps: ValidationDeps = defaultDeps,
  signal?: AbortSignal,
  config?: AppConfig
): Promise<ValidationResult> {
  const appConfig = config ?? deps.config;
  if (!appConfig) {
    throw new Error("AppConfig is required for OpenCode validation");
  }

  const { copyConfigs, execute } = resolveValidationOrchestration(deps);
  const runDir = path.join(deps.harnessRoot, "runs", runId);
  await deps.fs.rm(runDir, { recursive: true, force: true });
  await deps.fs.mkdir(runDir, { recursive: true });

  onLog(`Preparing validation workspace at ${runDir}`);
  throwIfAborted(signal);
  for (const [filename, content] of Object.entries(normalizeProjectFiles(files))) {
    const target = resolveProjectFilePath(runDir, filename);
    await deps.fs.mkdir(path.dirname(target), { recursive: true });
    await deps.fs.writeFile(target, content, "utf8");
    onLog(`Wrote ${filename} (${content.length} chars)`);
  }

  await copyConfigs(runDir, onLog, deps);

  onLog("Running ESLint on generated sources via OpenCode…");
  let lintOutput = "";
  let testOutput = "";
  const failures: string[] = [];

  const eslintCommand = `${process.execPath} node_modules/eslint/bin/eslint.js .`;
  try {
    lintOutput = await execute(eslintCommand, runDir, (line) => onLog(`[eslint] ${line}`), appConfig, signal);
  } catch (error) {
    failures.push(formatCommandFailure("ESLint", error));
  }

  onLog("Running Vitest test suite for generated app via OpenCode…");
  const vitestCommand = `${process.execPath} node_modules/vitest/vitest.mjs run`;
  try {
    testOutput = await execute(
      vitestCommand,
      runDir,
      (line) => onLog(`[vitest] ${line}`),
      appConfig,
      signal
    );
  } catch (error) {
    failures.push(formatCommandFailure("Vitest", error));
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }

  onLog("Validation finished successfully.");
  return { lintOutput, testOutput };
}

export async function copyHarnessConfigs(
  runDir: string,
  onLog: (line: string) => void,
  deps: ValidationDeps
): Promise<void> {
  const configs = ["eslint.config.js", "vitest.config.js"];
  for (const filename of configs) {
    const source = path.join(deps.harnessRoot, filename);
    const target = path.join(runDir, filename);
    await deps.fs.copyFile(source, target);
    onLog(`Copied harness config ${filename}`);
  }

  const modulesPath = path.join(deps.harnessRoot, "node_modules");
  const targetModules = path.join(runDir, "node_modules");
  try {
    await deps.fs.access(modulesPath);
  } catch {
    onLog("Harness node_modules missing; installing tooling dependencies…");
    const execute = resolveExecuteCommand(deps);
    const installConfig = deps.config;
    if (!installConfig) {
      throw new Error("AppConfig is required to install validation harness dependencies");
    }
    let lastInstallError: unknown;
    for (let attempt = 1; attempt <= MAX_HARNESS_INSTALL_ATTEMPTS; attempt++) {
      try {
        await execute(
          "npm ci --ignore-scripts --no-audit --no-fund",
          deps.harnessRoot,
          onLog,
          installConfig
        );
        break;
      } catch (error) {
        lastInstallError = error;
        if (attempt >= MAX_HARNESS_INSTALL_ATTEMPTS) {
          throw lastInstallError;
        }
        onLog(
          `Harness dependency install failed (attempt ${attempt}/${MAX_HARNESS_INSTALL_ATTEMPTS}); retrying…`
        );
      }
    }
  }

  await deps.fs.symlink(modulesPath, targetModules, "dir");
  onLog("Linked validation harness node_modules");
}

export async function runOpencodeValidationCommand(
  command: string,
  cwd: string,
  onLog: (line: string) => void,
  config: AppConfig,
  signal?: AbortSignal
): Promise<string> {
  try {
    return await runOpencodeShell(config, command, cwd, onLog, signal);
  } catch (error) {
    if (error instanceof RunPausedError || error instanceof RunStoppedError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Command failed (${command}), exit non-zero:\n${message}`);
  }
}

function formatCommandFailure(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label} failed:\n${message}`;
}

export function createValidationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowedKeys = [
    "APPDATA",
    "CI",
    "ComSpec",
    "FORCE_COLOR",
    "HOME",
    "LOCALAPPDATA",
    "NO_COLOR",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR"
  ];
  return Object.fromEntries(
    allowedKeys.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))
  );
}
