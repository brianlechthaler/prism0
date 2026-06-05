import { z } from "zod";
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
      for (const file of REQUIRED_FILES) {
        if (!parsed.files[file]) {
          throw new Error(`Missing required generated file: ${file}`);
        }
      }
      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Failed to parse generated project JSON: ${lastError}`);
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
