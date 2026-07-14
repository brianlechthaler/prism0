import { randomUUID } from "node:crypto";
import type { PrismDatabase } from "./db.js";
import { normalizeProjectFiles } from "./fileSafety.js";
import { randomSlug, randomToken } from "./crypto.js";

export type ProjectVersion = {
  id: string;
  projectId: string;
  versionNumber: number;
  files: Record<string, string>;
  idea: string | null;
  runId: string | null;
  createdAt: number;
};

export type HostedProject = {
  id: string;
  userId: string;
  name: string;
  slug: string;
  editToken: string;
  currentVersionId: string | null;
  createdAt: number;
  updatedAt: number;
  pageViews: number;
  publicUrl: string;
  manageUrl: string;
};

export type ProjectStoreOptions = {
  db: PrismDatabase;
  appBaseUrl: string;
  now?: () => number;
};

export class ProjectStore {
  private readonly db: PrismDatabase;
  private readonly appBaseUrl: string;
  private readonly now: () => number;

  constructor(options: ProjectStoreOptions) {
    this.db = options.db;
    this.appBaseUrl = options.appBaseUrl.replace(/\/$/, "");
    this.now = options.now ?? Date.now;
  }

  publishProject(input: {
    userId: string;
    name: string;
    files: Record<string, string>;
    idea?: string;
    runId?: string;
  }): HostedProject {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 120) {
      throw new ProjectError("Project name must be 1-120 characters");
    }
    if (Object.keys(input.files).length === 0) {
      throw new ProjectError("Project has no files to publish");
    }

    const normalizedFiles = normalizeProjectFiles(input.files);
    const id = randomUUID();
    const slug = this.createUniqueSlug();
    const editToken = randomToken(24);
    const createdAt = this.now();

    this.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, slug, edit_token, current_version_id, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`
      )
      .run(id, input.userId, name, slug, editToken, createdAt, createdAt);

    const version = this.insertVersion({
      projectId: id,
      versionNumber: 1,
      files: normalizedFiles,
      idea: input.idea ?? null,
      runId: input.runId ?? null,
      createdAt
    });

    this.db
      .prepare("UPDATE projects SET current_version_id = ?, updated_at = ? WHERE id = ?")
      .run(version.id, createdAt, id);

    return this.getProjectById(id)!;
  }

  saveVersion(input: {
    projectId: string;
    userId: string;
    files: Record<string, string>;
    idea?: string;
    runId?: string;
  }): HostedProject {
    const project = this.getProjectRecord(input.projectId);
    if (!project || project.deleted_at) throw new ProjectError("Project not found");
    if (project.user_id !== input.userId) throw new ProjectError("Forbidden");

    const latest = this.db
      .prepare("SELECT MAX(version_number) AS max_version FROM project_versions WHERE project_id = ?")
      .get(input.projectId) as { max_version: number | null };
    const versionNumber = (latest.max_version ?? 0) + 1;
    const createdAt = this.now();
    const normalizedFiles = normalizeProjectFiles(input.files);
    const version = this.insertVersion({
      projectId: input.projectId,
      versionNumber,
      files: normalizedFiles,
      idea: input.idea ?? null,
      runId: input.runId ?? null,
      createdAt
    });

    this.db
      .prepare("UPDATE projects SET current_version_id = ?, updated_at = ? WHERE id = ?")
      .run(version.id, createdAt, input.projectId);

    return this.getProjectById(input.projectId)!;
  }

  listForUser(userId: string): HostedProject[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM projects WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`
      )
      .all(userId) as Array<{ id: string }>;
    return rows.map((row) => this.getProjectById(row.id)!);
  }

  getProjectById(projectId: string): HostedProject | undefined {
    const project = this.getProjectRecord(projectId);
    if (!project || project.deleted_at) return undefined;
    return this.mapProject(project);
  }

  getProjectBySlug(slug: string): HostedProject | undefined {
    const project = this.db
      .prepare("SELECT * FROM projects WHERE slug = ? AND deleted_at IS NULL")
      .get(slug) as ProjectRow | undefined;
    return project ? this.mapProject(project) : undefined;
  }

  getProjectByEditToken(editToken: string): HostedProject | undefined {
    const project = this.db
      .prepare("SELECT * FROM projects WHERE edit_token = ? AND deleted_at IS NULL")
      .get(editToken) as ProjectRow | undefined;
    return project ? this.mapProject(project) : undefined;
  }

  getCurrentFiles(projectId: string): Record<string, string> | undefined {
    const project = this.getProjectRecord(projectId);
    if (!project?.current_version_id) return undefined;
    return this.getVersionFiles(project.current_version_id);
  }

  listVersions(projectId: string): ProjectVersion[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, version_number, files_json, idea, run_id, created_at
         FROM project_versions
         WHERE project_id = ?
         ORDER BY version_number DESC`
      )
      .all(projectId) as Array<{
      id: string;
      project_id: string;
      version_number: number;
      files_json: string;
      idea: string | null;
      run_id: string | null;
      created_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      versionNumber: row.version_number,
      files: JSON.parse(row.files_json) as Record<string, string>,
      idea: row.idea,
      runId: row.run_id,
      createdAt: row.created_at
    }));
  }

  revertToVersion(projectId: string, userId: string, versionId: string): HostedProject {
    const project = this.getProjectRecord(projectId);
    if (!project || project.deleted_at) throw new ProjectError("Project not found");
    if (project.user_id !== userId) throw new ProjectError("Forbidden");

    const version = this.db
      .prepare(
        `SELECT id, files_json, idea, run_id FROM project_versions WHERE id = ? AND project_id = ?`
      )
      .get(versionId, projectId) as
      | { id: string; files_json: string; idea: string | null; run_id: string | null }
      | undefined;
    if (!version) throw new ProjectError("Version not found");

    return this.saveVersion({
      projectId,
      userId,
      files: JSON.parse(version.files_json) as Record<string, string>,
      idea: version.idea ?? undefined,
      runId: version.run_id ?? undefined
    });
  }

  deleteProject(projectId: string, userId: string): void {
    const project = this.getProjectRecord(projectId);
    if (!project || project.deleted_at) throw new ProjectError("Project not found");
    if (project.user_id !== userId) throw new ProjectError("Forbidden");
    this.db.prepare("UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?").run(this.now(), this.now(), projectId);
  }

  recordPageView(projectId: string): void {
    this.db
      .prepare("INSERT INTO page_views (id, project_id, viewed_at) VALUES (?, ?, ?)")
      .run(randomUUID(), projectId, this.now());
  }

  getPageViewCount(projectId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM page_views WHERE project_id = ?")
      .get(projectId) as { count: number };
    return row.count;
  }

  private createUniqueSlug(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug = randomSlug(10);
      const existing = this.db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
      if (!existing) return slug;
    }
    throw new ProjectError("Could not allocate a unique project URL");
  }

  private insertVersion(input: {
    projectId: string;
    versionNumber: number;
    files: Record<string, string>;
    idea: string | null;
    runId: string | null;
    createdAt: number;
  }): { id: string } {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO project_versions (id, project_id, version_number, files_json, idea, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.versionNumber,
        JSON.stringify(input.files),
        input.idea,
        input.runId,
        input.createdAt
      );
    return { id };
  }

  private getProjectRecord(projectId: string): ProjectRow | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  }

  private getVersionFiles(versionId: string): Record<string, string> | undefined {
    const row = this.db
      .prepare("SELECT files_json FROM project_versions WHERE id = ?")
      .get(versionId) as { files_json: string } | undefined;
    return row ? (JSON.parse(row.files_json) as Record<string, string>) : undefined;
  }

  private mapProject(project: ProjectRow): HostedProject {
    return {
      id: project.id,
      userId: project.user_id,
      name: project.name,
      slug: project.slug,
      editToken: project.edit_token,
      currentVersionId: project.current_version_id,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      pageViews: this.getPageViewCount(project.id),
      publicUrl: `${this.appBaseUrl}/h/${project.slug}`,
      manageUrl: `${this.appBaseUrl}/manage/${project.edit_token}`
    };
  }
}

type ProjectRow = {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  edit_token: string;
  current_version_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}
