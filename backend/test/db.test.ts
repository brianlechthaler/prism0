import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../src/db.js";
import { removeDatabase, tempDatabasePath } from "./helpers.js";

describe("db", () => {
  let pathname: string | undefined;

  afterEach(() => {
    if (pathname) {
      removeDatabase(pathname);
      pathname = undefined;
    }
  });

  it("opens an in-memory database with schema tables", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "email_verification_tokens",
      "generation_history",
      "page_views",
      "project_versions",
      "projects",
      "sessions",
      "users"
    ]);
    closeDatabase(db);
  });

  it("opens a file-backed database and creates parent directories", () => {
    pathname = tempDatabasePath("db-file");
    const db = openDatabase(pathname);
    db.prepare(
      "INSERT INTO users (id, username, email, email_verified, password_hash, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)"
    ).run("u1", "tester", "tester@example.com", "hash", 1, 1);
    expect(db.prepare("SELECT username FROM users WHERE id = ?").get("u1")).toEqual({ username: "tester" });
    closeDatabase(db);
  });
});
