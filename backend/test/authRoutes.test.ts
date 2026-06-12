import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, AuthService } from "../src/auth.js";
import { openDatabase } from "../src/db.js";
import { GenerationHistoryService } from "../src/generationHistory.js";
import { ProjectStore } from "../src/projectStore.js";
import { registerAuthRoutes } from "../src/authRoutes.js";
import { LoginFailureTracker } from "../src/authRateLimit.js";
import type { AuthenticatedRequest } from "../src/authMiddleware.js";
import { createAuthMiddleware } from "../src/authMiddleware.js";
import express from "express";
import {
  createTestApp,
  createTestServices,
  registerAndLogin,
  testConfig,
  withAuthedServer,
  withServer
} from "./helpers.js";
import { RunStore } from "../src/runStore.js";

function jsonHeaders(cookie?: string): Record<string, string> {
  return cookie ? { cookie, "content-type": "application/json" } : { "content-type": "application/json" };
}

describe("authRoutes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns unauthenticated me responses", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ authenticated: false });
    });
  });

  it("registers, verifies, logs in, and serves dashboard data", async () => {
    const store = new RunStore();
    const { app, services } = createTestApp(store);
    const run = store.create("make app");
    store.complete(run.id, { "index.html": "<html></html>" });

    await withAuthedServer(app, async (port, { cookie, userId }) => {
      const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: jsonHeaders(cookie) });
      expect(me.status).toBe(200);
      expect((await me.json()).authenticated).toBe(true);

      const publishRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ runId: run.id, name: "Dashboard App" })
      });
      expect(publishRes.status).toBe(201);
      const publishJson = (await publishRes.json()) as { project: { id: string } };

      services.history.recordStart(userId, "history-run", "history idea", publishJson.project.id);
      services.history.recordComplete("history-run", { inputTokens: 3, outputTokens: 2, totalTokens: 5 });

      const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: jsonHeaders(cookie) });
      expect(dashboard.status).toBe(200);
      const dashboardJson = (await dashboard.json()) as {
        projects: Array<{ name: string }>;
        history: Array<{ runId: string }>;
        tokenSummary: { generationCount: number };
      };
      expect(dashboardJson.projects[0]?.name).toBe("Dashboard App");
      expect(dashboardJson.history[0]?.runId).toBe("history-run");
      expect(dashboardJson.tokenSummary.generationCount).toBe(1);
    });
  });

  it("returns auth feature flags", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/features`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ emailEnabled: true });
    });
  });

  it("rejects email registration when email is disabled", async () => {
    const config = { ...testConfig, authEmailEnabled: false };
    const { app } = createTestApp(new RunStore(), config);
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "blocked_email", email: "blocked@example.com", password: "password123" })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Email is not enabled");
    });
  });

  it("registers accounts without email and allows immediate login", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const emptyEmailRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "empty_email_route", email: "", password: "password123" })
      });
      expect(emptyEmailRes.status).toBe(201);

      const registerRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "no_email_route", password: "password123" })
      });
      expect(registerRes.status).toBe(201);
      const registerJson = (await registerRes.json()) as { user: { email: string | null; emailVerified: boolean } };
      expect(registerJson.user.email).toBeNull();
      expect(registerJson.user.emailVerified).toBe(true);

      const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "no_email_route", password: "password123" })
      });
      expect(loginRes.status).toBe(200);
    });
  });

  it("rejects invalid register payloads", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "ab", email: "bad", password: "short" })
      });
      expect(res.status).toBe(400);
    });
  });

  it("maps auth service errors during registration", async () => {
    const { app, services } = createTestApp();
    vi.spyOn(services.auth, "register").mockImplementation(() => {
      throw new Error("unexpected");
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "valid_user", email: "valid@example.com", password: "password123" })
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Authentication error");
    });
  });

  it("rejects invalid login payloads and unverified logins", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const invalid = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "", password: "" })
      });
      expect(invalid.status).toBe(400);

      const registerRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "unverified", email: "unverified@example.com", password: "password123" })
      });
      expect(registerRes.status).toBe(201);

      const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "unverified", password: "password123" })
      });
      expect(loginRes.status).toBe(400);
      expect(await loginRes.text()).toContain("Invalid username or password");
    });
  });

  it("logs out authenticated users", async () => {
    const { app } = createTestApp();
    await withAuthedServer(app, async (port, { cookie }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
        method: "POST",
        headers: jsonHeaders(cookie)
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("Max-Age=0");

      const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: jsonHeaders(cookie) });
      expect(me.status).toBe(401);
    });
  });

  it("requires authentication to log out", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, { method: "POST", headers: jsonHeaders() });
      expect(res.status).toBe(401);
    });
  });

  it("verifies email tokens and rejects missing or expired tokens", async () => {
    let now = 1_000_000;
    const db = openDatabase(":memory:");
    const authWithClock = new AuthService({
      db,
      sendEmail: async () => {},
      appBaseUrl: testConfig.appBaseUrl,
      sessionTtlMs: testConfig.sessionTtlMs,
      exposeVerificationToken: true,
      emailEnabled: true,
      now: () => now
    });
    const services = {
      auth: authWithClock,
      projects: new ProjectStore({ db, appBaseUrl: testConfig.appBaseUrl }),
      history: new GenerationHistoryService(db),
      sendEmail: async () => {}
    };
    const { app } = createTestApp(new RunStore(), testConfig, services);

    await withServer(app, async (port) => {
      const missing = await fetch(`http://127.0.0.1:${port}/api/auth/verify-email`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({})
      });
      expect(missing.status).toBe(400);

      const registerRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "verify_route", email: "verify_route@example.com", password: "password123" })
      });
      const registerJson = (await registerRes.json()) as { verificationToken: string };

      now += 24 * 60 * 60 * 1000 + 1;
      const expired = await fetch(`http://127.0.0.1:${port}/api/auth/verify-email`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ token: registerJson.verificationToken })
      });
      expect(expired.status).toBe(400);
      expect(await expired.text()).toContain("expired");

      const freshRegister = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "verify_ok", email: "verify_ok@example.com", password: "password123" })
      });
      const freshJson = (await freshRegister.json()) as { verificationToken: string };
      now += 1;
      const verified = await fetch(`http://127.0.0.1:${port}/api/auth/verify-email`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ token: freshJson.verificationToken })
      });
      expect(verified.status).toBe(200);
      expect((await verified.json()).verified).toBe(true);
    });
  });

  it("resends verification emails", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "resend_route", email: "resend_route@example.com", password: "password123" })
      });

      const invalid = await fetch(`http://127.0.0.1:${port}/api/auth/resend-verification`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "", password: "" })
      });
      expect(invalid.status).toBe(400);

      const resent = await fetch(`http://127.0.0.1:${port}/api/auth/resend-verification`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "resend_route", password: "password123" })
      });
      expect(resent.status).toBe(200);
      expect((await resent.json()).verificationToken).toBeDefined();
    });
  });

  it("updates profile, email, password, and deletes accounts", async () => {
    const { app } = createTestApp();
    await withAuthedServer(app, async (port, { cookie }) => {
      const profileInvalid = await fetch(`http://127.0.0.1:${port}/api/auth/profile`, {
        method: "PATCH",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ displayName: "x".repeat(65) })
      });
      expect(profileInvalid.status).toBe(400);

      const profile = await fetch(`http://127.0.0.1:${port}/api/auth/profile`, {
        method: "PATCH",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ displayName: "Tester" })
      });
      expect(profile.status).toBe(200);

      const emailInvalid = await fetch(`http://127.0.0.1:${port}/api/auth/change-email`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ email: "bad", password: "password123" })
      });
      expect(emailInvalid.status).toBe(400);

      const email = await fetch(`http://127.0.0.1:${port}/api/auth/change-email`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ email: "changed@example.com", password: "password123" })
      });
      expect(email.status).toBe(200);
      expect(email.headers.get("set-cookie")).toContain("Max-Age=0");

      const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: `user${port}`, password: "password123" })
      });
      expect(loginRes.status).toBe(400);

      const verifyRes = await fetch(`http://127.0.0.1:${port}/api/auth/resend-verification`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: `user${port}`, password: "password123" })
      });
      const verifyJson = (await verifyRes.json()) as { verificationToken: string };
      await fetch(`http://127.0.0.1:${port}/api/auth/verify-email`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ token: verifyJson.verificationToken })
      });
      const relogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: `user${port}`, password: "password123" })
      });
      const reloginCookie = relogin.headers.get("set-cookie") ?? "";

      const passwordInvalid = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
        method: "POST",
        headers: jsonHeaders(reloginCookie),
        body: JSON.stringify({ currentPassword: "password123", newPassword: "short" })
      });
      expect(passwordInvalid.status).toBe(400);

      const password = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
        method: "POST",
        headers: jsonHeaders(reloginCookie),
        body: JSON.stringify({ currentPassword: "password123", newPassword: "newpassword1" })
      });
      expect(password.status).toBe(200);

      const loginAgain = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: `user${port}`, password: "newpassword1" })
      });
      const finalCookie = loginAgain.headers.get("set-cookie") ?? "";

      const deleteInvalid = await fetch(`http://127.0.0.1:${port}/api/auth/account`, {
        method: "DELETE",
        headers: jsonHeaders(finalCookie),
        body: JSON.stringify({ password: "wrong-password" })
      });
      expect(deleteInvalid.status).toBe(400);

      const deleted = await fetch(`http://127.0.0.1:${port}/api/auth/account`, {
        method: "DELETE",
        headers: jsonHeaders(finalCookie),
        body: JSON.stringify({ password: "newpassword1" })
      });
      expect(deleted.status).toBe(200);
    });
  });

  it("requires authentication for protected auth routes", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      expect((await fetch(`http://127.0.0.1:${port}/api/dashboard`)).status).toBe(401);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/auth/profile`, { method: "PATCH", headers: jsonHeaders() })).status
      ).toBe(401);
    });
  });

  it("maps auth service failures to 500 responses", async () => {
    const { app, services } = createTestApp();
    await withAuthedServer(app, async (port, { cookie }) => {
      vi.spyOn(services.auth, "updateProfile").mockImplementation(() => {
        throw new Error("unexpected");
      });
      const profile = await fetch(`http://127.0.0.1:${port}/api/auth/profile`, {
        method: "PATCH",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ displayName: "Broken" })
      });
      expect(profile.status).toBe(500);

      vi.spyOn(services.auth, "changeEmail").mockImplementation(() => {
        throw new Error("unexpected");
      });
      const email = await fetch(`http://127.0.0.1:${port}/api/auth/change-email`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ email: "broken@example.com", password: "password123" })
      });
      expect(email.status).toBe(500);

      vi.spyOn(services.auth, "changePassword").mockImplementation(() => {
        throw new Error("unexpected");
      });
      const password = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ currentPassword: "password123", newPassword: "newpassword1" })
      });
      expect(password.status).toBe(500);

      const deleteInvalid = await fetch(`http://127.0.0.1:${port}/api/auth/account`, {
        method: "DELETE",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({})
      });
      expect(deleteInvalid.status).toBe(400);

      vi.spyOn(services.auth, "deleteAccount").mockImplementation(() => {
        throw new Error("unexpected");
      });
      const deleted = await fetch(`http://127.0.0.1:${port}/api/auth/account`, {
        method: "DELETE",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ password: "password123" })
      });
      expect(deleted.status).toBe(500);
    });
  });

  it("logs out even when the session token is missing from the request", async () => {
    const db = openDatabase(":memory:");
    const auth = new AuthService({
      db,
      sendEmail: async () => {},
      appBaseUrl: testConfig.appBaseUrl,
      sessionTtlMs: testConfig.sessionTtlMs,
      exposeVerificationToken: true,
      emailEnabled: true
    });
    const services = {
      auth,
      projects: new ProjectStore({ db, appBaseUrl: testConfig.appBaseUrl }),
      history: new GenerationHistoryService(db),
      sendEmail: async () => {}
    };
    const app = express();
    app.use(express.json());
    app.use(createAuthMiddleware(services.auth));
    app.use((req, _res, next) => {
      delete (req as AuthenticatedRequest).sessionToken;
      next();
    });
    registerAuthRoutes(app, services.auth, services.projects, services.history, testConfig);

    await withAuthedServer(app, async (port, { cookie }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
        method: "POST",
        headers: jsonHeaders(cookie)
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });

  it("returns lockout without Retry-After when retry seconds are zero", async () => {
    const config = { ...testConfig, authLoginMaxFailures: 2, authLoginLockoutMs: 60_000 };
    const loginFailures = {
      isLocked: () => true,
      lockoutRetryAfterSeconds: () => 0,
      recordFailure: vi.fn(),
      clear: vi.fn()
    } as unknown as LoginFailureTracker;
    const appWithTracker = express();
    appWithTracker.use(express.json());
    const services = createTestServices(config);
    appWithTracker.use(createAuthMiddleware(services.auth));
    registerAuthRoutes(appWithTracker, services.auth, services.projects, services.history, config, {
      loginFailures
    });

    await withServer(appWithTracker, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "any_user", password: "password123" })
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeNull();
    });
  });

  it("returns lockout without Retry-After after the final failed attempt", async () => {
    const config = { ...testConfig, authLoginMaxFailures: 2, authLoginLockoutMs: 60_000 };
    const loginFailures = {
      isLocked: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      lockoutRetryAfterSeconds: () => 0,
      recordFailure: vi.fn(),
      clear: vi.fn()
    } as unknown as LoginFailureTracker;
    const appWithTracker = express();
    appWithTracker.use(express.json());
    const services = createTestServices(config);
    appWithTracker.use(createAuthMiddleware(services.auth));
    vi.spyOn(services.auth, "login").mockImplementation(() => {
      throw new AuthError("Invalid username or password");
    });
    registerAuthRoutes(appWithTracker, services.auth, services.projects, services.history, config, {
      loginFailures
    });

    await withServer(appWithTracker, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "any_user", password: "wrong-password" })
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(loginFailures.recordFailure).toHaveBeenCalledWith("any_user");
    });
  });

  it("does not lock out on non-credential login errors", async () => {
    const { app, services } = createTestApp();
    vi.spyOn(services.auth, "login").mockImplementation(() => {
      throw new AuthError("Account disabled");
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "some_user", password: "password123" })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Account disabled");
    });
  });

  it("locks out repeated failed login attempts", async () => {
    const config = { ...testConfig, authLoginMaxFailures: 2, authLoginLockoutMs: 60_000 };
    const loginFailures = new LoginFailureTracker(2, 60_000);
    const appWithTracker = express();
    appWithTracker.use(express.json());
    const services = createTestServices(config);
    appWithTracker.use(createAuthMiddleware(services.auth));
    registerAuthRoutes(appWithTracker, services.auth, services.projects, services.history, config, {
      loginFailures
    });

    await withServer(appWithTracker, async (port) => {
      await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "lockout_user", email: "lockout@example.com", password: "password123" })
      });

      const fail1 = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "lockout_user", password: "wrong-password" })
      });
      expect(fail1.status).toBe(400);

      const locked = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "lockout_user", password: "wrong-password" })
      });
      expect(locked.status).toBe(429);
      expect(await locked.text()).toContain("Too many failed login attempts");

      const stillLocked = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "lockout_user", password: "wrong-password" })
      });
      expect(stillLocked.status).toBe(429);
      expect(stillLocked.headers.get("retry-after")).toBeTruthy();
    });
  });

  it("rate limits authentication endpoints per client", async () => {
    const config = { ...testConfig, authRateLimitMax: 1, authRateLimitWindowMs: 60_000 };
    const { app } = createTestApp(new RunStore(), config);
    await withServer(app, async (port) => {
      const first = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "rate_user", email: "rate@example.com", password: "password123" })
      });
      expect(first.status).toBe(201);

      const second = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "rate_user2", email: "rate2@example.com", password: "password123" })
      });
      expect(second.status).toBe(429);
    });
  });

  it("rejects resend verification for already verified accounts", async () => {
    const { app } = createTestApp();
    await withServer(app, async (port) => {
      const auth = await registerAndLogin(port, "verified_resend");
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/resend-verification`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "verified_resend", password: "password123" })
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("already verified");
      void auth;
    });
  });
});
