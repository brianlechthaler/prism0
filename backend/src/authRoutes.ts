import type { Express, Response } from "express";
import { z } from "zod";
import { AuthError, type AuthService } from "./auth.js";
import {
  clearSessionCookie,
  type AuthenticatedRequest,
  requireAuth,
  setSessionCookie
} from "./authMiddleware.js";
import type { GenerationHistoryService } from "./generationHistory.js";
import type { ProjectStore } from "./projectStore.js";

const RegisterSchema = z.object({
  username: z.string().trim().min(3).max(32),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200)
});

const LoginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(200)
});

const ProfileSchema = z.object({
  displayName: z.string().trim().max(64).nullable()
});

const ChangeEmailSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200)
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200)
});

const PasswordConfirmSchema = z.object({
  password: z.string().min(1).max(200)
});

export type AuthRoutesOptions = {
  sessionTtlMs: number;
  exposeVerificationToken: boolean;
};

export function registerAuthRoutes(
  app: Express,
  auth: AuthService,
  projects: ProjectStore,
  history: GenerationHistoryService,
  options: AuthRoutesOptions
): void {
  app.get("/api/auth/me", (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, user });
  });

  app.post("/api/auth/register", async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    try {
      const result = auth.register(parsed.data);
      res.status(201).json(result);
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  app.post("/api/auth/login", (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    try {
      const result = auth.login(parsed.data.username, parsed.data.password);
      setSessionCookie(res, result.sessionToken, options.sessionTtlMs);
      res.json({ user: result.user });
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  app.post("/api/auth/logout", requireAuth(), (req, res) => {
    const token = (req as AuthenticatedRequest).sessionToken;
    if (token) auth.logout(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/auth/verify-email", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
      res.status(400).send("Missing verification token");
      return;
    }

    try {
      const user = auth.verifyEmail(token);
      res.json({ verified: true, user });
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  app.post("/api/auth/resend-verification", (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    try {
      const result = auth.resendVerification(parsed.data.username, parsed.data.password);
      res.json(result);
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  app.patch("/api/auth/profile", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const parsed = ProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    try {
      const updated = auth.updateProfile(user.id, parsed.data.displayName);
      res.json({ user: updated });
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  app.post("/api/auth/change-email", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const parsed = ChangeEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    try {
      const updated = auth.changeEmail(user.id, parsed.data.email, parsed.data.password);
      clearSessionCookie(res);
      res.json({ user: updated, requiresVerification: true });
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  app.post("/api/auth/change-password", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    try {
      auth.changePassword(user.id, parsed.data.currentPassword, parsed.data.newPassword);
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  app.delete("/api/auth/account", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const parsed = PasswordConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    try {
      auth.deleteAccount(user.id, parsed.data.password);
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  app.get("/api/dashboard", requireAuth(), (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    res.json({
      user,
      projects: projects.listForUser(user.id),
      history: history.listForUser(user.id),
      tokenSummary: history.getTokenSummary(user.id)
    });
  });
}

function handleAuthError(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(400).send(error.message);
    return;
  }
  res.status(500).send("Authentication error");
}
