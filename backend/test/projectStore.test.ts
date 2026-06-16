import { describe, expect, it, vi } from "vitest";
import * as cryptoModule from "../src/crypto.js";
import { openDatabase } from "../src/db.js";
import { ProjectError, ProjectStore } from "../src/projectStore.js";

function createStore(now = () => 1000) {
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO users (id, username, email, email_verified, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run("user-1", "user1", "user1@example.com", "hash", 1, 1);
  db.prepare(
    `INSERT INTO users (id, username, email, email_verified, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run("user-2", "user2", "user2@example.com", "hash", 1, 1);
  const projects = new ProjectStore({ db, appBaseUrl: "http://127.0.0.1:8787/", now });
  return { db, projects };
}

describe("ProjectStore", () => {
  it("publishes projects with initial versions", () => {
    const { projects } = createStore();
    const project = projects.publishProject({
      userId: "user-1",
      name: "  My App  ",
      files: { "index.html": "<html></html>", "style.css": "body {}" },
      idea: "make app",
      runId: "run-1"
    });

    expect(project.name).toBe("My App");
    expect(project.publicUrl).toBe("http://127.0.0.1:8787/h/" + project.slug);
    expect(project.manageUrl).toBe(`http://127.0.0.1:8787/manage/${project.editToken}`);
    expect(projects.getCurrentFiles(project.id)).toEqual({
      "index.html": "<html></html>",
      "style.css": "body {}"
    });
    expect(projects.listVersions(project.id)).toHaveLength(1);
    expect(projects.getProjectBySlug(project.slug)?.id).toBe(project.id);
    expect(projects.getProjectByEditToken(project.editToken)?.id).toBe(project.id);
    expect(projects.listForUser("user-1")).toHaveLength(1);
  });

  it("rejects invalid publish input", () => {
    const { projects } = createStore();
    expect(() => projects.publishProject({ userId: "user-1", name: "", files: { "index.html": "x" } })).toThrow(
      ProjectError
    );
    expect(() => projects.publishProject({ userId: "user-1", name: "App", files: {} })).toThrow(/no files/);
  });

  it("saves versions and tracks page views", () => {
    let now = 1000;
    const { projects } = createStore(() => now);
    const project = projects.publishProject({
      userId: "user-1",
      name: "Versioned App",
      files: { "index.html": "v1" }
    });

    now = 2000;
    const updated = projects.saveVersion({
      projectId: project.id,
      userId: "user-1",
      files: { "index.html": "v2" },
      idea: "update",
      runId: "run-2"
    });
    expect(updated.updatedAt).toBe(2000);
    expect(projects.listVersions(project.id)).toHaveLength(2);
    expect(projects.getCurrentFiles(project.id)).toEqual({ "index.html": "v2" });

    projects.recordPageView(project.id);
    projects.recordPageView(project.id);
    expect(projects.getProjectById(project.id)?.pageViews).toBe(2);
  });

  it("rejects unauthorized or missing version saves", () => {
    const { projects } = createStore();
    const project = projects.publishProject({
      userId: "user-1",
      name: "Protected",
      files: { "index.html": "v1" }
    });

    expect(() =>
      projects.saveVersion({ projectId: "missing", userId: "user-1", files: { "index.html": "v2" } })
    ).toThrow(/Project not found/);
    expect(() =>
      projects.saveVersion({ projectId: project.id, userId: "other-user", files: { "index.html": "v2" } })
    ).toThrow(/Forbidden/);
  });

  it("reverts to prior versions by creating a new version", () => {
    const { projects } = createStore();
    const project = projects.publishProject({
      userId: "user-1",
      name: "Revert App",
      files: { "index.html": "v1" }
    });
    const saved = projects.saveVersion({
      projectId: project.id,
      userId: "user-1",
      files: { "index.html": "v2" }
    });
    const versions = projects.listVersions(project.id);
    const original = versions.find((version) => version.versionNumber === 1)!;

    const reverted = projects.revertToVersion(project.id, "user-1", original.id);
    expect(reverted.currentVersionId).not.toBe(saved.currentVersionId);
    expect(projects.getCurrentFiles(project.id)).toEqual({ "index.html": "v1" });
    expect(projects.listVersions(project.id)).toHaveLength(3);

    expect(() => projects.revertToVersion("missing", "user-1", original.id)).toThrow(/Project not found/);
    expect(() => projects.revertToVersion(project.id, "other-user", original.id)).toThrow(/Forbidden/);
    expect(() => projects.revertToVersion(project.id, "user-1", "missing-version")).toThrow(/Version not found/);
  });

  it("soft deletes projects and hides them from lookups", () => {
    const { projects } = createStore();
    const project = projects.publishProject({
      userId: "user-1",
      name: "Delete Me",
      files: { "index.html": "v1" }
    });

    expect(() => projects.deleteProject(project.id, "other-user")).toThrow(/Forbidden/);
    projects.deleteProject(project.id, "user-1");
    expect(projects.getProjectById(project.id)).toBeUndefined();
    expect(projects.getProjectBySlug(project.slug)).toBeUndefined();
    expect(projects.getProjectByEditToken(project.editToken)).toBeUndefined();
    expect(projects.listForUser("user-1")).toHaveLength(0);
    expect(projects.getCurrentFiles(project.id)).toEqual({ "index.html": "v1" });

    expect(() => projects.deleteProject("missing", "user-1")).toThrow(/Project not found/);
    expect(() => projects.deleteProject(project.id, "other-user")).toThrow(/Project not found/);
  });

  it("throws when a unique slug cannot be allocated", () => {
    const { db, projects } = createStore();
    const slugSpy = vi.spyOn(cryptoModule, "randomSlug").mockReturnValue("collisions");
    db.prepare(
      `INSERT INTO projects (id, user_id, name, slug, edit_token, current_version_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`
    ).run("existing", "user-1", "Existing", "collisions", "token", 1, 1);

    expect(() =>
      projects.publishProject({ userId: "user-2", name: "Another", files: { "index.html": "x" } })
    ).toThrow(/unique project URL/);
    slugSpy.mockRestore();
  });

  it("handles missing version files and empty version history", () => {
    const { db, projects } = createStore();
    const project = projects.publishProject({
      userId: "user-1",
      name: "Version Edge Cases",
      files: { "index.html": "v1" }
    });
    db.prepare("UPDATE projects SET current_version_id = ? WHERE id = ?").run("missing-version", project.id);
    expect(projects.getCurrentFiles(project.id)).toBeUndefined();

    db.prepare("DELETE FROM project_versions WHERE project_id = ?").run(project.id);
    const saved = projects.saveVersion({
      projectId: project.id,
      userId: "user-1",
      files: { "index.html": "v2" }
    });
    expect(saved.currentVersionId).toBeDefined();
  });
});
