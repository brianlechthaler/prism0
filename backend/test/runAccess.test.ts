import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db.js";
import { ProjectStore } from "../src/projectStore.js";
import { assertRunAccess, validateProjectOwnership } from "../src/runAccess.js";
import { RunStore } from "../src/runStore.js";

describe("assertRunAccess", () => {
  it("allows anonymous access when auth is disabled", () => {
    const store = new RunStore();
    const run = store.create("idea");
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as import("express").Response;

    const result = assertRunAccess(store, run.id, false, undefined, res);
    expect(result?.id).toBe(run.id);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("denies access when the run owner does not match", () => {
    const store = new RunStore();
    const run = store.create("idea", "owner-a");
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as import("express").Response;

    expect(assertRunAccess(store, run.id, true, "owner-b", res)).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("validateProjectOwnership", () => {
  it("allows missing project ids and rejects foreign projects", () => {
    const db = openDatabase(":memory:");
    const projects = new ProjectStore({ db, appBaseUrl: "http://127.0.0.1:8787" });
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as import("express").Response;

    expect(validateProjectOwnership(projects, undefined, undefined, res)).toBe(true);

    expect(
      validateProjectOwnership(projects, "00000000-0000-4000-8000-000000000001", undefined, res)
    ).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows project ids owned by the current user", () => {
    const db = openDatabase(":memory:");
    const projects = new ProjectStore({ db, appBaseUrl: "http://127.0.0.1:8787" });
    const now = Date.now();
    db.prepare(
      "INSERT INTO users (id, username, email, email_verified, password_hash, display_name, created_at, updated_at) VALUES (?, ?, NULL, 1, 'hash', NULL, ?, ?)"
    ).run("user-1", "owner", now, now);
    const project = projects.publishProject({
      userId: "user-1",
      name: "Owned",
      files: { "index.html": "<html></html>" }
    });
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as import("express").Response;

    expect(
      validateProjectOwnership(projects, project.id, {
        id: "user-1",
        username: "owner",
        email: null,
        emailVerified: true,
        displayName: null,
        createdAt: now
      }, res)
    ).toBe(true);
  });
});
