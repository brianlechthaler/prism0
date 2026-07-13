import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "./authMiddleware.js";
import { requireAuth, requireVerifiedEmail } from "./authMiddleware.js";
import { ProjectError, type ProjectStore } from "./projectStore.js";
import type { RunStore } from "./runStore.js";
import { assertRunAccess } from "./runAccess.js";
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

type ManageRateBucket = {
  count: number;
  resetAt: number;
};

export function createManageRateLimitGuard(
  max = 30,
  windowMs = 60_000,
  now: () => number = Date.now
): RequestHandler {
  const buckets = new Map<string, ManageRateBucket>();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const currentTime = now();
    const existing = buckets.get(key);
    const bucket =
      existing && existing.resetAt > currentTime
        ? existing
        : { count: 0, resetAt: currentTime + windowMs };

    if (bucket.count >= max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - currentTime) / 1000)));
      res.status(429).send("Too many requests; try again later");
      buckets.set(key, bucket);
      return;
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    next();
  };
}

export function registerProjectRoutes(
  app: Express,
  projects: ProjectStore,
  store: RunStore,
  authEnabled = true,
  authEmailEnabled = false
): void {
  if (authEnabled) {
    registerAuthenticatedProjectRoutes(app, projects, store, authEnabled, authEmailEnabled);
  }
  registerManageProjectRoutes(app, projects, authEnabled);
}

function registerAuthenticatedProjectRoutes(
  app: Express,
  projects: ProjectStore,
  store: RunStore,
  authEnabled: boolean,
  authEmailEnabled: boolean
): void {
  const authRequired = [requireAuth(), requireVerifiedEmail(authEmailEnabled)];

  app.get("/api/projects", ...authRequired, (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    res.json({ projects: projects.listForUser(user.id) });
  });

  app.post("/api/projects", ...authRequired, (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    const run = assertRunAccess(
      store,
      parsed.data.runId,
      authEnabled,
      user.id,
      res
    );
    if (!run || run.status !== "done" || Object.keys(run.files).length === 0) {
      if (run) res.status(409).send("Run is not ready to publish");
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

  app.get("/api/projects/:projectId", ...authRequired, (req, res) => {
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

  app.post("/api/projects/:projectId/versions", ...authRequired, (req, res) => {
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
      const run = assertRunAccess(store, parsed.data.runId, authEnabled, user.id, res);
      if (!run || run.status !== "done" || Object.keys(run.files).length === 0) {
        if (run) res.status(409).send("Run is not ready to save");
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

  app.post("/api/projects/:projectId/revert", ...authRequired, (req, res) => {
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

function registerManageProjectRoutes(
  app: Express,
  projects: ProjectStore,
  _authEnabled: boolean
): void {
  const manageRateLimit = createManageRateLimitGuard();

  app.get("/api/projects/manage/:editToken", manageRateLimit, (req, res) => {
    const editToken = routeParam(req.params.editToken);
    const project = projects.getProjectByEditToken(editToken);
    if (!project) {
      res.status(404).send("Project not found");
      return;
    }

    const user = (req as AuthenticatedRequest).user;
    const versions = projects.listVersions(project.id);
    res.json({
      project: toPublicHostedProject(project),
      versions,
      files: projects.getCurrentFiles(project.id),
      canEdit: Boolean(user && user.id === project.userId)
    });
  });

  app.post("/api/projects/manage/:editToken/revert", manageRateLimit, (req, res) => {
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
      res.json({ project: toPublicHostedProject(updated) });
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

  app.delete("/api/projects/manage/:editToken", manageRateLimit, (req, res) => {
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

function toPublicHostedProject(project: import("./projectStore.js").HostedProject) {
  const { editToken, ...publicProject } = project;
  void editToken;
  return publicProject;
}

function handleProjectError(res: import("express").Response, error: unknown): void {
  if (error instanceof ProjectError) {
    const status = error.message === "Forbidden" ? 403 : 400;
    res.status(status).send(error.message);
    return;
  }
  res.status(500).send("Project error");
}
