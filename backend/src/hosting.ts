import type { Express, Request, Response } from "express";
import path from "node:path";
import type { ProjectStore } from "./projectStore.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

export function hostingRequestFromWildcard(file: string | string[] | undefined): {
  requestedFile: string;
  countView: boolean;
} {
  const wildcard = routeWildcard(file);
  return {
    requestedFile: wildcard || "index.html",
    countView: wildcard === "" || wildcard === "index.html"
  };
}

export function registerHostingRoutes(app: Express, projects: ProjectStore): void {
  app.get("/h/:slug", (req, res) => serveHostedFile(req, res, projects, "index.html", true));
  app.get("/h/:slug/*file", (req, res) => {
    const { requestedFile, countView } = hostingRequestFromWildcard(req.params.file);
    serveHostedFile(req, res, projects, requestedFile, countView);
  });
}

function serveHostedFile(
  req: Request,
  res: Response,
  projects: ProjectStore,
  requestedFile: string,
  countView: boolean
): void {
  const slug = routeParam(req.params.slug);
  const project = projects.getProjectBySlug(slug);
  if (!project) {
    res.status(404).send("Hosted project not found");
    return;
  }

  const files = projects.getCurrentFiles(project.id);
  if (!files) {
    res.status(404).send("Hosted project has no published version");
    return;
  }

  const normalized = normalizeHostedPath(requestedFile);
  const content = files[normalized] ?? files[normalized.replace(/^\//, "")];
  if (content === undefined) {
    if (normalized !== "index.html" && files["index.html"]) {
      res.redirect(302, `/h/${slug}/`);
      return;
    }
    res.status(404).send("File not found");
    return;
  }

  if (countView) {
    projects.recordPageView(project.id);
  }

  res.setHeader("Content-Type", contentTypeForFile(normalized));
  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.send(content);
}

export function normalizeHostedPath(filePath: string): string {
  const cleaned = path.posix.normalize(filePath.replace(/^\/+/, ""));
  if (cleaned === "." || cleaned === "/") return "index.html";
  if (cleaned.startsWith("..")) return "index.html";
  return cleaned;
}

export function contentTypeForFile(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function routeWildcard(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join("/");
  return value ?? "";
}

export function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
