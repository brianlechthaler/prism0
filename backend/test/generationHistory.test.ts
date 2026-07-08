import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { GenerationHistoryService } from "../src/generationHistory.js";

describe("GenerationHistoryService", () => {
  it("records generation lifecycle and summarizes usage", () => {
    let now = 1000;
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO users (id, username, email, email_verified, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    ).run("user-1", "user1", "user1@example.com", "hash", 1, 1);
    const history = new GenerationHistoryService(db, () => now);

    const started = history.recordStart("user-1", "run-1", "make app");
    expect(started.status).toBe("running");
    expect(started.projectId).toBeNull();

    now = 2000;
    history.recordComplete("run-1", { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    history.recordFailure("missing-run");
    history.recordFailure("run-1", { inputTokens: 1, outputTokens: 2, totalTokens: 3 });

    const entry = history.getByRunId("run-1");
    expect(entry?.status).toBe("error");
    expect(entry?.inputTokens).toBe(1);
    expect(entry?.outputTokens).toBe(2);

    history.recordStart("user-1", "run-2", "another app");
    history.recordComplete("run-2");

    const list = history.listForUser("user-1", 1);
    expect(list).toHaveLength(1);
    expect(list[0]?.runId).toBe("run-2");

    const summary = history.getTokenSummary("user-1");
    expect(summary).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      generationCount: 2
    });

    expect(history.getByRunId("missing")).toBeUndefined();
    expect(history.getTokenSummary("missing-user")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      generationCount: 0
    });
  });
});
