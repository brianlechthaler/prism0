import type { Express } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "./authMiddleware.js";
import { requireAuth } from "./authMiddleware.js";
import { ProjectError, type ProjectStore } from "./projectStore.js";
import type { RunStore } from "./runStore.js";
import { routeParam } from "./routes.js";

const PublishSchema = z.object({
  runId: z.string().uuid(),
  name: z.string().trim().min(1).max(120)
});

const SaveVersionSchema = z.object({
  runId: z.string().uuid().optional(),
  idea: z.string().trim().max(2000).optional()
});

const RevertSchema = z.object({
  versionId: z.string().uuid()
});

export function registerProjectRoutes(
  app: Express,
  projects: ProjectStore,
  store: RunStore,
  authEnabled = true
): void {
  if (authEnabled) {
    registerAuthenticatedProjectRoutes(app, projects, store);
  }
  registerManageProjectRoutes(app, projects);
}

function registerAuthenticatedProjectRoutes(
  app: Express,
  projects: ProjectStore,
  store: RunStore
): void {
  app.get("/api/projects", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    res.json({ projects: projects.listForUser(user.id) });
  });

  app.post("/api/projects", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    const run = store.get(parsed.data.runId);
    if (!run || run.status !== "done" || Object.keys(run.files).length === 0) {
      res.status(409).send("Run is not ready to publish");
      return;
    }

    try {
      const project = projects.publishProject({
        userId: user.id,
        name: parsed.data.name,
        files: run.files,
        idea: run.idea,
        runId: run.id
      });
      res.status(201).json({ project });
    } catch (error) {
      handleProjectError(res, error);
    }
  });

  app.get("/api/projects/:projectId", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const projectId = routeParam(req.params.projectId);
    const project = projects.getProjectById(projectId);
    if (!project || project.userId !== user.id) {
      res.status(404).send("Project not found");
      return;
    }

    res.json({
      project,
      versions: projects.listVersions(projectId),
      files: projects.getCurrentFiles(projectId)
    });
  });

  app.post("/api/projects/:projectId/versions", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const projectId = routeParam(req.params.projectId);
    const parsed = SaveVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    const project = projects.getProjectById(projectId);
    if (!project || project.userId !== user.id) {
      res.status(404).send("Project not found");
      return;
    }

    let files: Record<string, string> | undefined;
    let idea = parsed.data.idea;
    if (parsed.data.runId) {
      const run = store.get(parsed.data.runId);
      if (!run || run.status !== "done" || Object.keys(run.files).length === 0) {
        res.status(409).send("Run is not ready to save");
        return;
      }
      files = run.files;
      idea = idea ?? run.idea;
    }

    if (!files) {
      res.status(400).send("runId is required to save a new version");
      return;
    }

    try {
      const updated = projects.saveVersion({
        projectId,
        userId: user.id,
        files,
        idea,
        runId: parsed.data.runId
      });
      res.json({ project: updated });
    } catch (error) {
      handleProjectError(res, error);
    }
  });

  app.post("/api/projects/:projectId/revert", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const projectId = routeParam(req.params.projectId);
    const parsed = RevertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    try {
      const project = projects.revertToVersion(projectId, user.id, parsed.data.versionId);
      res.json({ project });
    } catch (error) {
      handleProjectError(res, error);
    }
  });
}

function registerManageProjectRoutes(app: Express, projects: ProjectStore): void {
  app.get("/api/projects/manage/:editToken", (req, res) => {
    const editToken = routeParam(req.params.editToken);
    const project = projects.getProjectByEditToken(editToken);
    if (!project) {
      res.status(404).send("Project not found");
      return;
    }

    const user = (req as AuthenticatedRequest).user;
    const versions = projects.listVersions(project.id);
    res.json({
      project,
      versions,
      files: projects.getCurrentFiles(project.id),
      canEdit: Boolean(user && user.id === project.userId)
    });
  });

  app.post("/api/projects/manage/:editToken/revert", (req, res) => {
    const editToken = routeParam(req.params.editToken);
    const parsed = RevertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    const project = projects.getProjectByEditToken(editToken);
    if (!project) {
      res.status(404).send("Project not found");
      return;
    }

    const user = (req as AuthenticatedRequest).user;
    if (!user || user.id !== project.userId) {
      res.status(403).send("Authentication required to revert versions");
      return;
    }

    try {
      const updated = projects.revertToVersion(project.id, user.id, parsed.data.versionId);
      res.json({ project: updated });
    } catch (error) {
      handleProjectError(res, error);
    }
  });

  app.delete("/api/projects/:projectId", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const projectId = routeParam(req.params.projectId);

    try {
      projects.deleteProject(projectId, user.id);
      res.json({ ok: true });
    } catch (error) {
      handleProjectError(res, error);
    }
  });

  app.delete("/api/projects/manage/:editToken", (req, res) => {
    const editToken = routeParam(req.params.editToken);
    const project = projects.getProjectByEditToken(editToken);
    if (!project) {
      res.status(404).send("Project not found");
      return;
    }

    const user = (req as AuthenticatedRequest).user;
    if (!user || user.id !== project.userId) {
      res.status(403).send("Authentication required to delete this project");
      return;
    }

    try {
      projects.deleteProject(project.id, user.id);
      res.json({ ok: true });
    } catch (error) {
      handleProjectError(res, error);
    }
  });
}

function handleProjectError(res: import("express").Response, error: unknown): void {
  if (error instanceof ProjectError) {
    const status = error.message === "Forbidden" ? 403 : 400;
    res.status(status).send(error.message);
    return;
  }
  res.status(500).send("Project error");
}
