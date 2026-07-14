import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectError } from "../src/projectStore.js";
import { createManageRateLimitGuard } from "../src/projectRoutes.js";
import { RunStore } from "../src/runStore.js";
import {
  createTestApp,
  registerAndLogin,
  testConfig,
  withAuthedServer,
  withServer
} from "./helpers.js";

function jsonHeaders(cookie?: string): Record<string, string> {
  return cookie ? { cookie, "content-type": "application/json" } : { "content-type": "application/json" };
}

async function publishRun(port: number, cookie: string, runId: string, name = "Published App") {
  return fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: "POST",
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ runId, name })
  });
}

describe("projectRoutes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires authentication to list projects", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
      expect(res.status).toBe(401);
    });
  });

  it("does not register authenticated project routes when login is disabled", async () => {
    const { app } = createTestApp(new RunStore(), { ...testConfig, authEnabled: false });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
      expect(res.status).toBe(404);
    });
  });

  it("publishes completed runs and rejects invalid or unfinished runs", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const invalid = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ runId: "not-a-uuid", name: "" })
      });
      expect(invalid.status).toBe(400);

      const pendingRun = store.create("pending", userId);
      const notReady = await publishRun(port, cookie, pendingRun.id);
      expect(notReady.status).toBe(409);

      const doneRun = store.create("done app", userId);
      store.complete(doneRun.id, { "index.html": "<html></html>" });
      const published = await publishRun(port, cookie, doneRun.id);
      expect(published.status).toBe(201);
      const publishedJson = (await published.json()) as { project: { id: string; slug: string } };

      const list = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: jsonHeaders(cookie) });
      expect((await list.json()).projects).toHaveLength(1);

      const detail = await fetch(`http://127.0.0.1:${port}/api/projects/${publishedJson.project.id}`, {
        headers: jsonHeaders(cookie)
      });
      expect(detail.status).toBe(200);
      const detailJson = (await detail.json()) as { files: Record<string, string>; versions: unknown[] };
      expect(detailJson.files["index.html"]).toContain("<html>");
      expect(detailJson.versions).toHaveLength(1);

      const missing = await fetch(`http://127.0.0.1:${port}/api/projects/${randomUUID()}`, {
        headers: jsonHeaders(cookie)
      });
      expect(missing.status).toBe(404);
    });
  });

  it("serves manage pages with edit permissions", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const run = store.create("manage app", userId);
      store.complete(run.id, { "index.html": "<html></html>" });

      const published = await publishRun(port, cookie, run.id, "Manage App");
      const { project } = (await published.json()) as { project: { editToken: string } };

      const anonymous = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}`);
      expect(anonymous.status).toBe(200);
      const anonymousJson = (await anonymous.json()) as { canEdit: boolean; project: { editToken?: string } };
      expect(anonymousJson.canEdit).toBe(false);
      expect(anonymousJson.project.editToken).toBeUndefined();

      const owner = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}`, {
        headers: jsonHeaders(cookie)
      });
      const ownerJson = (await owner.json()) as { canEdit: boolean; project: { editToken?: string } };
      expect(ownerJson.canEdit).toBe(true);
      expect(ownerJson.project.editToken).toBeUndefined();

      const missing = await fetch(`http://127.0.0.1:${port}/api/projects/manage/missing-token`);
      expect(missing.status).toBe(404);
    });
  });

  it("returns forbidden when publishing another user's run", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);

    await withServer(app, async (port) => {
      const owner = await registerAndLogin(port, `publish_owner_${port}`);
      const other = await registerAndLogin(port, `publish_other_${port}`);
      const run = store.create("shared run", owner.userId);
      store.complete(run.id, { "index.html": "<html></html>" });

      const res = await publishRun(port, other.cookie, run.id);
      expect(res.status).toBe(403);
    });
  });

  it("returns forbidden when saving a version from another user's run", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);

    await withServer(app, async (port) => {
      const owner = await registerAndLogin(port, `save_owner_${port}`);
      const other = await registerAndLogin(port, `save_other_${port}`);
      const ownerRun = store.create("owner run", owner.userId);
      store.complete(ownerRun.id, { "index.html": "v1" });
      const published = await publishRun(port, owner.cookie, ownerRun.id);
      const { project } = (await published.json()) as { project: { id: string } };
      const otherRun = store.create("other run", other.userId);
      store.complete(otherRun.id, { "index.html": "v2" });

      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/versions`, {
        method: "POST",
        headers: jsonHeaders(owner.cookie),
        body: JSON.stringify({ runId: otherRun.id })
      });
      expect(res.status).toBe(403);
    });
  });

  it("saves new versions from completed runs", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const initialRun = store.create("initial", userId);
      store.complete(initialRun.id, { "index.html": "v1" });
      const updateRun = store.create("update", userId);
      store.complete(updateRun.id, { "index.html": "v2" });

      const published = await publishRun(port, cookie, initialRun.id);
      const { project } = (await published.json()) as { project: { id: string } };

      const missingRun = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/versions`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({})
      });
      expect(missingRun.status).toBe(400);

      const invalidRun = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/versions`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ runId: "not-a-uuid" })
      });
      expect(invalidRun.status).toBe(400);

      const notReady = store.create("still running", userId);
      const badRun = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/versions`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ runId: notReady.id })
      });
      expect(badRun.status).toBe(409);

      const saved = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/versions`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ runId: updateRun.id, idea: "updated" })
      });
      expect(saved.status).toBe(200);
      expect((await saved.json()).project.pageViews).toBeDefined();
    });
  });

  it("reverts and deletes projects via owner routes", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const run = store.create("revert app", userId);
      store.complete(run.id, { "index.html": "v1" });

      const published = await publishRun(port, cookie, run.id);
      const { project } = (await published.json()) as { project: { id: string; editToken: string } };
      const detail = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
        headers: jsonHeaders(cookie)
      });
      const versions = ((await detail.json()) as { versions: Array<{ id: string; versionNumber: number }> }).versions;
      const original = versions.find((version) => version.versionNumber === 1)!;

      const invalidRevert = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/revert`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ versionId: "not-a-uuid" })
      });
      expect(invalidRevert.status).toBe(400);

      const reverted = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/revert`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ versionId: original.id })
      });
      expect(reverted.status).toBe(200);

      const manageDeleteDenied = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}`, {
        method: "DELETE"
      });
      expect(manageDeleteDenied.status).toBe(403);

      const deleted = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
        method: "DELETE",
        headers: jsonHeaders(cookie)
      });
      expect(deleted.status).toBe(200);
    });
  });

  it("supports manage revert and delete when authenticated as owner", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const run = store.create("manage revert", userId);
      store.complete(run.id, { "index.html": "v1" });

      const published = await publishRun(port, cookie, run.id, "Manage Revert");
      const { project } = (await published.json()) as { project: { id: string; editToken: string } };
      const detail = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
        headers: jsonHeaders(cookie)
      });
      const versions = ((await detail.json()) as { versions: Array<{ id: string; versionNumber: number }> }).versions;
      const original = versions.find((version) => version.versionNumber === 1)!;

      const revertDenied = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}/revert`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ versionId: original.id })
      });
      expect(revertDenied.status).toBe(403);

      const reverted = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}/revert`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ versionId: original.id })
      });
      expect(reverted.status).toBe(200);

      const deleted = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}`, {
        method: "DELETE",
        headers: jsonHeaders(cookie)
      });
      expect(deleted.status).toBe(200);
    });
  });

  it("forbids cross-user project access and maps project errors", async () => {
    const store = new RunStore();
    const { app, services } = createTestApp(store);

    await withServer(app, async (port) => {
      const owner = await registerAndLogin(port, "owner");
      const other = await registerAndLogin(port, "other");
      const run = store.create("shared", owner.userId);
      store.complete(run.id, { "index.html": "v1" });
      const published = await publishRun(port, owner.cookie, run.id);
      const { project } = (await published.json()) as { project: { id: string } };

      const forbidden = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
        headers: jsonHeaders(other.cookie)
      });
      expect(forbidden.status).toBe(404);

      vi.spyOn(services.projects, "publishProject").mockImplementation(() => {
        throw new Error("unexpected");
      });
      const serverError = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: jsonHeaders(owner.cookie),
        body: JSON.stringify({ runId: run.id, name: "Broken" })
      });
      expect(serverError.status).toBe(500);
      expect(await serverError.text()).toBe("Project error");
    });
  });

  it("returns forbidden when saving versions for another user's project", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);

    await withServer(app, async (port) => {
      const owner = await registerAndLogin(port, "owner2");
      const other = await registerAndLogin(port, "other2");
      const run = store.create("owner only", owner.userId);
      store.complete(run.id, { "index.html": "v1" });
      const updateRun = store.create("update forbidden", other.userId);
      store.complete(updateRun.id, { "index.html": "v2" });
      const published = await publishRun(port, owner.cookie, run.id);
      const { project } = (await published.json()) as { project: { id: string } };

      const denied = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/versions`, {
        method: "POST",
        headers: jsonHeaders(other.cookie),
        body: JSON.stringify({ runId: updateRun.id })
      });
      expect(denied.status).toBe(404);
    });
  });

  it("returns forbidden for cross-user revert and delete operations", async () => {
    const store = new RunStore();
    const { app, services } = createTestApp(store);

    await withServer(app, async (port) => {
      const owner = await registerAndLogin(port, "owner3");
      const other = await registerAndLogin(port, "other3");
      const run = store.create("forbidden ops", owner.userId);
      store.complete(run.id, { "index.html": "v1" });
      const updateRun = store.create("forbidden save", owner.userId);
      store.complete(updateRun.id, { "index.html": "v2" });
      const published = await publishRun(port, owner.cookie, run.id);
      const { project } = (await published.json()) as { project: { id: string; editToken: string } };
      const detail = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
        headers: jsonHeaders(owner.cookie)
      });
      const versions = ((await detail.json()) as { versions: Array<{ id: string; versionNumber: number }> }).versions;
      const original = versions.find((version) => version.versionNumber === 1)!;

      const revertForbidden = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/revert`, {
        method: "POST",
        headers: jsonHeaders(other.cookie),
        body: JSON.stringify({ versionId: original.id })
      });
      expect(revertForbidden.status).toBe(403);

      const deleteForbidden = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
        method: "DELETE",
        headers: jsonHeaders(other.cookie)
      });
      expect(deleteForbidden.status).toBe(403);

      const manageMissing = await fetch(`http://127.0.0.1:${port}/api/projects/manage/missing-token/revert`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ versionId: original.id })
      });
      expect(manageMissing.status).toBe(404);

      const manageInvalid = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}/revert`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ versionId: "not-a-uuid" })
      });
      expect(manageInvalid.status).toBe(400);

      const manageDeleteMissing = await fetch(`http://127.0.0.1:${port}/api/projects/manage/missing-token`, {
        method: "DELETE",
        headers: jsonHeaders(owner.cookie)
      });
      expect(manageDeleteMissing.status).toBe(404);

      vi.spyOn(services.projects, "saveVersion").mockImplementation(() => {
        throw new ProjectError("Forbidden");
      });
      const saveForbidden = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/versions`, {
        method: "POST",
        headers: jsonHeaders(owner.cookie),
        body: JSON.stringify({ runId: updateRun.id })
      });
      expect(saveForbidden.status).toBe(403);

      vi.spyOn(services.projects, "revertToVersion").mockImplementation(() => {
        throw new ProjectError("Version not found");
      });
      const manageRevertError = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}/revert`, {
        method: "POST",
        headers: jsonHeaders(owner.cookie),
        body: JSON.stringify({ versionId: original.id })
      });
      expect(manageRevertError.status).toBe(400);

      vi.spyOn(services.projects, "revertToVersion").mockImplementation(() => {
        throw new Error("unexpected");
      });
      const revertServerError = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/revert`, {
        method: "POST",
        headers: jsonHeaders(owner.cookie),
        body: JSON.stringify({ versionId: original.id })
      });
      expect(revertServerError.status).toBe(500);

      vi.spyOn(services.projects, "deleteProject").mockImplementation(() => {
        throw new Error("unexpected");
      });
      const deleteServerError = await fetch(`http://127.0.0.1:${port}/api/projects/manage/${project.editToken}`, {
        method: "DELETE",
        headers: jsonHeaders(owner.cookie)
      });
      expect(deleteServerError.status).toBe(500);
    });
  });

  it("rate limits manage project lookups", async () => {
    let now = 0;
    const guard = createManageRateLimitGuard(1, 60_000, () => now);
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      setHeader: vi.fn()
    } as unknown as import("express").Response;
    const next = vi.fn();
    const req = { ip: "127.0.0.1", socket: {} } as import("express").Request;

    guard(req, res, next);
    guard(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(429);

    now = 60_001;
    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    const socketOnly = { socket: { remoteAddress: "socket-client" } } as import("express").Request;
    guard(socketOnly, res, next);
    expect(next).toHaveBeenCalledTimes(3);

    const unknownClient = { socket: {} } as import("express").Request;
    guard(unknownClient, res, next);
    expect(next).toHaveBeenCalledTimes(4);
  });
});

