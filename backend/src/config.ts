import { z } from "zod";
import type { CliArgs } from "./parseArgs.js";

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_MODEL: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().optional()
});

export function formatConfigIssues(
  issues: Array<{ path: Array<string | number>; message: string }>
): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("; ");
}

export type AppConfig = {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  port: number;
};

export function loadConfig(env: NodeJS.ProcessEnv, cli: CliArgs = {}): AppConfig {
  const merged = {
    OPENAI_API_KEY: cli.apiKey ?? env.OPENAI_API_KEY,
    OPENAI_BASE_URL: cli.baseUrl ?? env.OPENAI_BASE_URL,
    OPENAI_MODEL: cli.model ?? env.OPENAI_MODEL,
    PORT: cli.port ?? env.PORT
  };

  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const msg = formatConfigIssues(parsed.error.issues);
    throw new Error(`Invalid configuration: ${msg}`);
  }

  if (!parsed.data.OPENAI_API_KEY) {
    throw new Error(
      "Invalid configuration: OPENAI_API_KEY: API key is required (set OPENAI_API_KEY or pass --api-key)"
    );
  }

  return {
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    openaiBaseUrl: parsed.data.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiModel: parsed.data.OPENAI_MODEL ?? "gpt-4.1-mini",
    port: parsed.data.PORT ?? 8787
  };
}

