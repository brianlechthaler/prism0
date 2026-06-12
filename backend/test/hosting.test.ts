import { describe, expect, it } from "vitest";
import { RunStore } from "../src/runStore.js";
import { contentTypeForFile, hostingRequestFromWildcard, normalizeHostedPath, routeParam, routeWildcard } from "../src/hosting.js";
import { createTestApp, withAuthedServer, withServer } from "./helpers.js";

function jsonHeaders(cookie: string): Record<string, string> {
  return { cookie, "content-type": "application/json" };
}

describe("hosting helpers", () => {
  it("normalizes hosted file paths safely", () => {
    expect(normalizeHostedPath("")).toBe("index.html");
    expect(normalizeHostedPath("/")).toBe("index.html");
    expect(normalizeHostedPath(".")).toBe("index.html");
    expect(normalizeHostedPath("../secret.txt")).toBe("index.html");
    expect(normalizeHostedPath("assets/app.js")).toBe("assets/app.js");
  });

  it("maps file extensions to content types", () => {
    expect(contentTypeForFile("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeForFile("styles/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeForFile("bundle.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeForFile("data.json")).toBe("application/json; charset=utf-8");
    expect(contentTypeForFile("icon.svg")).toBe("image/svg+xml");
    expect(contentTypeForFile("photo.png")).toBe("image/png");
    expect(contentTypeForFile("photo.jpg")).toBe("image/jpeg");
    expect(contentTypeForFile("photo.jpeg")).toBe("image/jpeg");
    expect(contentTypeForFile("photo.gif")).toBe("image/gif");
    expect(contentTypeForFile("photo.webp")).toBe("image/webp");
    expect(contentTypeForFile("favicon.ico")).toBe("image/x-icon");
    expect(contentTypeForFile("readme.txt")).toBe("text/plain; charset=utf-8");
    expect(contentTypeForFile("archive.bin")).toBe("application/octet-stream");
  });

  it("joins wildcard path segments", () => {
    expect(routeWildcard(["assets", "app.js"])).toBe("assets/app.js");
    expect(routeWildcard("plain.js")).toBe("plain.js");
    expect(routeWildcard(undefined)).toBe("");
    expect(routeParam(["ignored"])).toBe("");
    expect(routeParam("value")).toBe("value");
  });

  it("derives hosted wildcard requests", () => {
    expect(hostingRequestFromWildcard("")).toEqual({ requestedFile: "index.html", countView: true });
    expect(hostingRequestFromWildcard("index.html")).toEqual({
      requestedFile: "index.html",
      countView: true
    });
    expect(hostingRequestFromWildcard("assets/app.js")).toEqual({
      requestedFile: "assets/app.js",
      countView: false
    });
    expect(hostingRequestFromWildcard(undefined)).toEqual({
      requestedFile: "index.html",
      countView: true
    });
  });
});

describe("hosting routes", () => {
  it("serves hosted project files, redirects, and tracks page views", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);
    const run = store.create("hosted app");
    store.complete(run.id, {
      "index.html": "<html>home</html>",
      "assets/app.js": "console.log('hi')",
      "styles/app.css": "body { color: red; }"
    });

    await withAuthedServer(app, async (port, { cookie }) => {
      const publishRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ runId: run.id, name: "Hosted App" })
      });
      const { project } = (await publishRes.json()) as { project: { slug: string; pageViews: number } };

      const missing = await fetch(`http://127.0.0.1:${port}/h/missing-slug`);
      expect(missing.status).toBe(404);

      const index = await fetch(`http://127.0.0.1:${port}/h/${project.slug}`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await index.text()).toContain("home");

      const trailingSlash = await fetch(`http://127.0.0.1:${port}/h/${project.slug}/`);
      expect(trailingSlash.status).toBe(200);
      expect(await trailingSlash.text()).toContain("home");

      const css = await fetch(`http://127.0.0.1:${port}/h/${project.slug}/styles/app.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(await css.text()).toContain("color: red");

      const redirect = await fetch(`http://127.0.0.1:${port}/h/${project.slug}/missing-page`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe(`/h/${project.slug}/`);

      const manageRes = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: jsonHeaders(cookie) });
      const listed = (await manageRes.json()) as { projects: Array<{ pageViews: number }> };
      expect(listed.projects[0]?.pageViews).toBe(2);
    });
  });

  it("returns 404 when hosted projects have no published files", async () => {
    const store = new RunStore();
    const { app, services } = createTestApp(store);

    await withServer(app, async (port) => {
      const db = (services.projects as unknown as { db: import("better-sqlite3").Database }).db;
      db.prepare(
        `INSERT INTO users (id, username, email, email_verified, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      ).run("offline-user", "offline", "offline@example.com", "hash", 1, 1);
      const project = services.projects.publishProject({
        userId: "offline-user",
        name: "No Version",
        files: { "index.html": "<html></html>" }
      });
      db.prepare("UPDATE projects SET current_version_id = NULL WHERE id = ?").run(project.id);

      const res = await fetch(`http://127.0.0.1:${port}/h/${project.slug}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Hosted project has no published version");
    });
  });

  it("serves nested hosted paths without counting asset requests as page views", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);
    const run = store.create("nested hosted");
    store.complete(run.id, {
      "index.html": "<html>home</html>",
      "leading-slash.html": "<html>leading</html>"
    });

    await withAuthedServer(app, async (port, { cookie }) => {
      const publishRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ runId: run.id, name: "Nested Hosted" })
      });
      const { project } = (await publishRes.json()) as { project: { slug: string } };

      const leading = await fetch(`http://127.0.0.1:${port}/h/${project.slug}/leading-slash.html`);
      expect(leading.status).toBe(200);
      expect(await leading.text()).toContain("leading");

      const indexAgain = await fetch(`http://127.0.0.1:${port}/h/${project.slug}/index.html`);
      expect(indexAgain.status).toBe(200);

      const missingFile = await fetch(`http://127.0.0.1:${port}/h/${project.slug}/does-not-exist.txt`, {
        redirect: "manual"
      });
      expect(missingFile.status).toBe(302);
    });
  });

  it("returns file not found when index.html is unavailable", async () => {
    const store = new RunStore();
    const { app } = createTestApp(store);
    const run = store.create("no index");
    store.complete(run.id, { "readme.txt": "hello" });

    await withAuthedServer(app, async (port, { cookie }) => {
      const publishRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ runId: run.id, name: "No Index" })
      });
      const { project } = (await publishRes.json()) as { project: { slug: string } };

      const res = await fetch(`http://127.0.0.1:${port}/h/${project.slug}/missing.txt`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("File not found");
    });
  });
});
