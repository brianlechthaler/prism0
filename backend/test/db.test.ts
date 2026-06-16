import Database from "better-sqlite3";
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

  it("allows nullable email addresses and migrates legacy not-null schemas", () => {
    pathname = tempDatabasePath("db-nullable-email");
    const legacy = new Database(pathname);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email_verified INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        "INSERT INTO users (id, username, email, email_verified, password_hash, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)"
      )
      .run("legacy", "legacy_user", "legacy@example.com", "hash", 1, 1);
    legacy.close();

    const db = openDatabase(pathname);
    db.prepare(
      "INSERT INTO users (id, username, email, email_verified, password_hash, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?, ?)"
    ).run("u2", "no_email_user", "hash", 1, 1);
    expect(db.prepare("SELECT email FROM users WHERE id = ?").get("u2")).toEqual({ email: null });
    expect(db.prepare("SELECT email FROM users WHERE id = ?").get("legacy")).toEqual({
      email: "legacy@example.com"
    });
    closeDatabase(db);
  });
});
