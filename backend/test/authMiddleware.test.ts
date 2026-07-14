import { describe, expect, it, vi } from "vitest";
import express from "express";
import { AuthService } from "../src/auth.js";
import {
  assertOwner,
  clearSessionCookie,
  createAuthMiddleware,
  createAuthGuard,
  readSessionCookie,
  requireAuth,
  requireVerifiedEmail,
  SESSION_COOKIE,
  SESSION_COOKIE_PATH,
  setSessionCookie,
  type AuthenticatedRequest
} from "../src/authMiddleware.js";
import { openDatabase } from "../src/db.js";

function createAuthService(sessionTtlMs = 60_000) {
  const db = openDatabase(":memory:");
  const auth = new AuthService({
    db,
    sendEmail: async () => {},
    appBaseUrl: "http://127.0.0.1:8787",
    sessionTtlMs,
    exposeVerificationToken: true,
    emailEnabled: true
  });
  return auth;
}

describe("authMiddleware", () => {
  it("reads session cookies from request headers", () => {
    expect(readSessionCookie({ headers: {} } as express.Request)).toBeUndefined();
    expect(
      readSessionCookie({
        headers: { cookie: "other=value; another=test" }
      } as express.Request)
    ).toBeUndefined();
    expect(
      readSessionCookie({
        headers: { cookie: `${SESSION_COOKIE}=abc123; other=value` }
      } as express.Request)
    ).toBe("abc123");
    expect(
      readSessionCookie({
        headers: { cookie: `${SESSION_COOKIE}=hello%3Dworld` }
      } as express.Request)
    ).toBe("hello=world");
    expect(
      readSessionCookie({
        headers: { cookie: `${SESSION_COOKIE}=` }
      } as express.Request)
    ).toBeUndefined();
  });

  it("sets and clears session cookies", () => {
    const append = vi.fn();
    const res = { append } as unknown as express.Response;

    setSessionCookie(res, "token-value", 5000);
    expect(append).toHaveBeenCalledWith(
      "Set-Cookie",
      `${SESSION_COOKIE}=token-value; HttpOnly; Path=${SESSION_COOKIE_PATH}; SameSite=Lax; Max-Age=5`
    );

    clearSessionCookie(res);
    expect(append).toHaveBeenLastCalledWith(
      "Set-Cookie",
      `${SESSION_COOKIE}=; HttpOnly; Path=${SESSION_COOKIE_PATH}; SameSite=Lax; Max-Age=0`
    );
  });

  it("adds Secure attribute in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const append = vi.fn();
    const res = { append } as unknown as express.Response;

    setSessionCookie(res, "token", 1000);
    clearSessionCookie(res);
    expect(append.mock.calls[0]?.[1]).toContain("Secure");
    expect(append.mock.calls[0]?.[1]).toContain("SameSite=Strict");
    expect(append.mock.calls[1]?.[1]).toContain("Secure");
    vi.unstubAllEnvs();
  });

  it("attaches authenticated users and clears invalid sessions", async () => {
    const auth = createAuthService();
    const { verificationToken } = await auth.register({
      username: "middleware_user",
      email: "middleware@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);
    const { sessionToken } = await auth.login("middleware_user", "securepass12");

    const app = express();
    app.use(createAuthMiddleware(auth));
    app.get("/me", (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      res.json({ authenticated: Boolean(user), sessionToken: (req as AuthenticatedRequest).sessionToken });
    });

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    const authed = await fetch(`http://127.0.0.1:${port}/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` }
    });
    expect(await authed.json()).toEqual({ authenticated: true, sessionToken });

    const cleared = await fetch(`http://127.0.0.1:${port}/me`, {
      headers: { cookie: `${SESSION_COOKIE}=invalid-token` }
    });
    expect(await cleared.json()).toEqual({ authenticated: false });
    expect(cleared.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);

    const anonymous = await fetch(`http://127.0.0.1:${port}/me`);
    expect(await anonymous.json()).toEqual({ authenticated: false, sessionToken: undefined });

    server.close();
  });

  it("requires authentication for protected routes", async () => {
    const app = express();
    app.use(requireAuth());
    app.get("/protected", (_req, res) => res.send("ok"));

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    const denied = await fetch(`http://127.0.0.1:${port}/protected`);
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe("Authentication required");

    server.close();
  });

  it("skips email verification when email is disabled", async () => {
    const app = express();
    app.get("/verified-only", requireVerifiedEmail(false), (_req, res) => res.send("ok"));

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/verified-only`);
    expect(res.status).toBe(200);
    server.close();
  });

  it("requires a user before checking email verification", async () => {
    const app = express();
    app.get("/verified-only", requireVerifiedEmail(true), (_req, res) => res.send("ok"));

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/verified-only`);
    expect(res.status).toBe(401);
    server.close();
  });


  it("blocks unverified email users when verification is required", async () => {
    const app = express();
    app.get("/verified-only", (req, res, next) => {
      (req as AuthenticatedRequest).user = {
        id: "user-1",
        username: "unverified_user",
        email: "unverified@example.com",
        emailVerified: false,
        displayName: null,
        createdAt: Date.now()
      };
      requireVerifiedEmail(true)(req, res, next);
    }, (_req, res) => res.send("ok"));

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    const denied = await fetch(`http://127.0.0.1:${port}/verified-only`);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("not verified");

    server.close();
  });

  it("skips authentication when the auth guard is disabled", async () => {
    const app = express();
    app.use(createAuthGuard(false));
    app.get("/protected", (_req, res) => res.send("ok"));

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    const allowed = await fetch(`http://127.0.0.1:${port}/protected`);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("ok");

    server.close();
  });

  it("asserts resource ownership", () => {
    const next = vi.fn();
    const send = vi.fn();
    const res = { status: vi.fn(() => ({ send })) } as unknown as express.Response;

    const req = { user: undefined } as AuthenticatedRequest;
    expect(assertOwner(req, "owner-id", res, next)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);

    const wrongUser = { user: { id: "other-id" } } as AuthenticatedRequest;
    expect(assertOwner(wrongUser, "owner-id", res, next)).toBe(false);

    const owner = { user: { id: "owner-id" } } as AuthenticatedRequest;
    expect(assertOwner(owner, "owner-id", res, next)).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });
});
