import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import express from "express";
import { AuthService } from "../src/auth.js";
import { createAuthMiddleware } from "../src/authMiddleware.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import type { EmailSender } from "../src/email.js";
import { GenerationHistoryService } from "../src/generationHistory.js";
import { ProjectStore } from "../src/projectStore.js";
import { registerAuthRoutes } from "../src/authRoutes.js";
import { registerProjectRoutes } from "../src/projectRoutes.js";
import { registerHostingRoutes } from "../src/hosting.js";
import { registerRoutes } from "../src/routes.js";
import { RunStore } from "../src/runStore.js";

export const testConfig: AppConfig = {
  openaiApiKey: "k",
  openaiBaseUrl: "https://example.com/v1",
  openaiModel: "m",
  openaiModels: ["m"],
  modelPickerEnabled: false,
  yoloModeEnabled: false,
  host: "127.0.0.1",
  port: 8787,
  requestTimeoutMs: 120_000,
  contextWindowTokens: 128_000,
  contextCompressThreshold: 0.9,
  maxRuns: 100,
  maxActiveRuns: 100,
  generationRateLimitWindowMs: 60_000,
  generationRateLimitMax: 100,
  trustProxy: false,
  databasePath: ":memory:",
  appBaseUrl: "http://127.0.0.1:8787",
  sessionTtlMs: 60_000,
  authExposeVerificationToken: true,
  authRateLimitWindowMs: 60_000,
  authRateLimitMax: 100,
  authLoginMaxFailures: 100,
  authLoginLockoutMs: 60_000,
  authEmailEnabled: true,
  authEnabled: true
};

export type TestServices = {
  auth: AuthService;
  projects: ProjectStore;
  history: GenerationHistoryService;
  sendEmail: EmailSender;
};

export function createTestServices(
  config: AppConfig = testConfig,
  sendEmail: EmailSender = async () => {}
): TestServices {
  const db = openDatabase(config.databasePath);
  const auth = new AuthService({
    db,
    sendEmail,
    appBaseUrl: config.appBaseUrl,
    sessionTtlMs: config.sessionTtlMs,
    exposeVerificationToken: config.authExposeVerificationToken,
    emailEnabled: config.authEmailEnabled
  });
  const projects = new ProjectStore({ db, appBaseUrl: config.appBaseUrl });
  const history = new GenerationHistoryService(db);
  return { auth, projects, history, sendEmail };
}

export function createTestApp(
  store = new RunStore(),
  config: AppConfig = testConfig,
  services = createTestServices(config)
) {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware(services.auth));
  registerAuthRoutes(app, services.auth, services.projects, services.history, config);
  registerProjectRoutes(app, services.projects, store, config.authEnabled);
  registerHostingRoutes(app, services.projects);
  registerRoutes(app, config, store, { history: services.history });
  return { app, store, services };
}

export async function withServer<T>(app: Express, fn: (port: number) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  try {
    return await fn(addr.port);
  } finally {
    server.close();
  }
}

export async function withAuthedServer<T>(
  app: Express,
  fn: (port: number, auth: { cookie: string; userId: string }) => Promise<T>,
  username?: string
): Promise<T> {
  return withServer(app, async (port) => {
    const auth = await registerAndLogin(port, username ?? `user${port}`);
    return fn(port, auth);
  });
}

export function tempDatabasePath(name: string): string {
  return path.join(os.tmpdir(), `prism0-test-${name}-${process.pid}.db`);
}

export function removeDatabase(pathname: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${pathname}${suffix}`);
    } catch {
      // ignore missing files
    }
  }
}

export async function registerAndLogin(
  port: number,
  username = "tester",
  password = "password123"
): Promise<{ cookie: string; userId: string }> {
  const registerRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, email: `${username}@example.com`, password })
  });
  expect(registerRes.status).toBe(201);
  const registerJson = (await registerRes.json()) as { verificationToken: string };
  const verifyRes = await fetch(
    `http://127.0.0.1:${port}/api/auth/verify-email`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: registerJson.verificationToken })
    }
  );
  expect(verifyRes.status).toBe(200);

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  expect(loginRes.status).toBe(200);
  const cookie = loginRes.headers.get("set-cookie") ?? "";
  const userJson = (await loginRes.json()) as { user: { id: string } };
  return { cookie, userId: userJson.user.id };
}

import { expect } from "vitest";
