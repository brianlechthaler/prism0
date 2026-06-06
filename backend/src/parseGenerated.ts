import { z } from "zod";
import { normalizeProjectFiles } from "./fileSafety.js";
import type { GeneratedProject } from "./types.js";

const GeneratedSchema = z.object({
  summary: z.string().min(1),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "files must include at least one file"
  })
});

const REQUIRED_FILES = ["index.html", "index.js", "styles.css", "index.test.js", "package.json"];

export function parseGeneratedResponse(raw: string): GeneratedProject {
  const candidates = collectJsonCandidates(raw);

  let lastError = "No JSON payload found in model response";
  for (const candidate of candidates) {
    try {
      const parsed = GeneratedSchema.parse(JSON.parse(candidate));
      const files = normalizeProjectFiles(parsed.files);
      validatePackageJson(files["package.json"]);
      for (const file of REQUIRED_FILES) {
        if (!files[file]) {
          throw new Error(`Missing required generated file: ${file}`);
        }
      }
      return { summary: parsed.summary, files };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Failed to parse generated project JSON: ${lastError}`);
}

function validatePackageJson(rawPackageJson: string | undefined): void {
  if (!rawPackageJson) return;

  const parsed = JSON.parse(rawPackageJson) as {
    type?: unknown;
    scripts?: Record<string, unknown>;
    dependencies?: unknown;
    devDependencies?: unknown;
    optionalDependencies?: unknown;
    peerDependencies?: unknown;
    bundleDependencies?: unknown;
    bundledDependencies?: unknown;
  };

  if (parsed.type !== "module") {
    throw new Error('Generated package.json must set "type": "module"');
  }

  const scripts = parsed.scripts ?? {};
  const scriptEntries = Object.keys(scripts);
  if (
    scriptEntries.some((script) => script !== "lint" && script !== "test") ||
    scripts.lint !== "eslint ." ||
    scripts.test !== "vitest run"
  ) {
    throw new Error('Generated package.json scripts must be exactly "lint": "eslint ." and "test": "vitest run"');
  }

  const dependencyFields = [
    parsed.dependencies,
    parsed.devDependencies,
    parsed.optionalDependencies,
    parsed.peerDependencies,
    parsed.bundleDependencies,
    parsed.bundledDependencies
  ];
  if (dependencyFields.some((field) => field !== undefined)) {
    throw new Error("Generated package.json cannot declare dependencies");
  }
}

function collectJsonCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const candidates = new Set<string>();

  if (trimmed) candidates.add(trimmed);

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const block of fenced) {
    if (block) candidates.add(block);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return [...candidates];
}
