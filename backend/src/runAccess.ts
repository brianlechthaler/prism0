import type { Response } from "express";
import type { AuthenticatedRequest } from "./authMiddleware.js";
import type { PublicUser } from "./auth.js";
import type { ProjectStore } from "./projectStore.js";
import type { RunStore } from "./runStore.js";
import type { GenerationRun } from "./types.js";

export function assertRunAccess(
  store: RunStore,
  runId: string,
  authEnabled: boolean,
  userId: string | undefined,
  res: Response
): GenerationRun | undefined {
  const run = store.get(runId);
  if (!run) {
    res.status(404).send("Run not found");
    return undefined;
  }

  if (authEnabled && !store.isOwnedBy(runId, userId)) {
    res.status(403).send("Forbidden");
    return undefined;
  }

  return run;
}

export function validateProjectOwnership(
  projects: ProjectStore,
  projectId: string | undefined,
  user: PublicUser | undefined,
  res: Response
): boolean {
  if (!projectId) return true;
  if (!user) {
    res.status(403).send("Forbidden");
    return false;
  }
  const project = projects.getProjectById(projectId);
  if (!project || project.userId !== user.id) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

export function requestUserId(req: AuthenticatedRequest): string | undefined {
  return req.user?.id;
}
