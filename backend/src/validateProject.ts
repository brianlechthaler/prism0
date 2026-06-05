import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HARNESS_ROOT = path.resolve(__dirname, "../validation-harness");

export type ValidationResult = {
  lintOutput: string;
  testOutput: string;
};

export type ValidationDeps = {
  fs: Pick<typeof fs, "rm" | "mkdir" | "writeFile" | "copyFile" | "access" | "symlink">;
  spawn: typeof nodeSpawn;
  harnessRoot: string;
  copyConfigs?: (runDir: string, onLog: (line: string) => void, deps: ValidationDeps) => Promise<void>;
  execute?: (
    command: string,
    args: string[],
    cwd: string,
    onLog: (line: string) => void,
    spawnImpl?: ValidationDeps["spawn"]
  ) => Promise<string>;
};

const defaultDeps: ValidationDeps = {
  fs,
  spawn: nodeSpawn,
  harnessRoot: HARNESS_ROOT
};

export function resolveValidationOrchestration(deps: ValidationDeps) {
  return {
    copyConfigs: deps.copyConfigs ?? copyHarnessConfigs,
    execute: resolveExecuteCommand(deps)
  };
}

export function resolveExecuteCommand(deps: ValidationDeps) {
  return deps.execute ?? runCommand;
}

export async function validateGeneratedProject(
  runId: string,
  files: Record<string, string>,
  onLog: (line: string) => void,
  deps: ValidationDeps = defaultDeps
): Promise<ValidationResult> {
  const { copyConfigs, execute } = resolveValidationOrchestration(deps);
  const runDir = path.join(deps.harnessRoot, "runs", runId);
  await deps.fs.rm(runDir, { recursive: true, force: true });
  await deps.fs.mkdir(runDir, { recursive: true });

  onLog(`Preparing validation workspace at ${runDir}`);
  for (const [filename, content] of Object.entries(files)) {
    const target = path.join(runDir, filename);
    await deps.fs.mkdir(path.dirname(target), { recursive: true });
    await deps.fs.writeFile(target, content, "utf8");
    onLog(`Wrote ${filename} (${content.length} chars)`);
  }

  await copyConfigs(runDir, onLog, deps);

  onLog("Running ESLint on generated sources…");
  const lintOutput = await execute("npm", ["run", "lint"], runDir, onLog, deps.spawn);

  onLog("Running Vitest test suite for generated app…");
  const testOutput = await execute("npm", ["run", "test"], runDir, onLog, deps.spawn);

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
    await deps.fs.symlink(modulesPath, targetModules, "dir");
    onLog("Linked validation harness node_modules");
  } catch {
    onLog("Harness node_modules missing; installing tooling dependencies…");
    const execute = resolveExecuteCommand(deps);
    await execute("npm", ["install"], runDir, onLog, deps.spawn);
  }
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onLog: (line: string) => void,
  spawnImpl: ValidationDeps["spawn"] = nodeSpawn
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === "win32"
    }) as ChildProcess;

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        onLog(`[stdout] ${line}`);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        onLog(`[stderr] ${line}`);
      }
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const combined = `${stdout}\n${stderr}`.trim();
      if (code === 0) {
        resolve(combined);
        return;
      }
      reject(new Error(`Command failed (${command} ${args.join(" ")}), exit ${code}:\n${combined}`));
    });
  });
}
