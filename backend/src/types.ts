export type SseMessage =
  | { type: "log"; line: string }
  | { type: "done"; files: Record<string, string> }
  | { type: "error"; message: string };

export type RunStatus = "pending" | "running" | "done" | "error";

export type GenerationRun = {
  id: string;
  idea: string;
  status: RunStatus;
  logs: string[];
  files: Record<string, string>;
  error?: string;
};

export type GeneratedProject = {
  files: Record<string, string>;
  summary: string;
};
