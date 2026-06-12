import { randomUUID } from "node:crypto";
import type { PrismDatabase } from "./db.js";
import type { RunUsageMetrics } from "./types.js";

export type GenerationHistoryEntry = {
  id: string;
  userId: string;
  projectId: string | null;
  runId: string;
  idea: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  updatedAt: number;
};

export type UserTokenSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  generationCount: number;
};

export class GenerationHistoryService {
  constructor(
    private readonly db: PrismDatabase,
    private readonly now: () => number = Date.now
  ) {}

  recordStart(userId: string, runId: string, idea: string, projectId?: string): GenerationHistoryEntry {
    const id = randomUUID();
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO generation_history
         (id, user_id, project_id, run_id, idea, status, input_tokens, output_tokens, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', 0, 0, ?, ?)`
      )
      .run(id, userId, projectId ?? null, runId, idea, createdAt, createdAt);
    return this.getByRunId(runId)!;
  }

  recordComplete(runId: string, usage?: RunUsageMetrics): void {
    const updatedAt = this.now();
    this.db
      .prepare(
        `UPDATE generation_history
         SET status = 'done', input_tokens = ?, output_tokens = ?, updated_at = ?
         WHERE run_id = ?`
      )
      .run(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, updatedAt, runId);
  }

  recordFailure(runId: string, usage?: RunUsageMetrics): void {
    const updatedAt = this.now();
    this.db
      .prepare(
        `UPDATE generation_history
         SET status = 'error', input_tokens = ?, output_tokens = ?, updated_at = ?
         WHERE run_id = ?`
      )
      .run(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, updatedAt, runId);
  }

  listForUser(userId: string, limit = 50): GenerationHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, project_id, run_id, idea, status, input_tokens, output_tokens, created_at, updated_at
         FROM generation_history
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userId, limit) as Array<{
      id: string;
      user_id: string;
      project_id: string | null;
      run_id: string;
      idea: string;
      status: string;
      input_tokens: number;
      output_tokens: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => this.mapRow(row));
  }

  getTokenSummary(userId: string): UserTokenSummary {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COUNT(*) AS generation_count
         FROM generation_history
         WHERE user_id = ?`
      )
      .get(userId) as { input_tokens: number; output_tokens: number; generation_count: number };

    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.input_tokens + row.output_tokens,
      generationCount: row.generation_count
    };
  }

  getByRunId(runId: string): GenerationHistoryEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT id, user_id, project_id, run_id, idea, status, input_tokens, output_tokens, created_at, updated_at
         FROM generation_history WHERE run_id = ?`
      )
      .get(runId) as
      | {
          id: string;
          user_id: string;
          project_id: string | null;
          run_id: string;
          idea: string;
          status: string;
          input_tokens: number;
          output_tokens: number;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  private mapRow(row: {
    id: string;
    user_id: string;
    project_id: string | null;
    run_id: string;
    idea: string;
    status: string;
    input_tokens: number;
    output_tokens: number;
    created_at: number;
    updated_at: number;
  }): GenerationHistoryEntry {
    return {
      id: row.id,
      userId: row.user_id,
      projectId: row.project_id,
      runId: row.run_id,
      idea: row.idea,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
