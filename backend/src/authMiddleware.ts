import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthService, PublicUser } from "./auth.js";

export const SESSION_COOKIE = "prism0_session";
export const SESSION_COOKIE_PATH = "/api";

export type AuthenticatedRequest = Request & {
  user?: PublicUser;
  sessionToken?: string;
};

export function createAuthMiddleware(auth: AuthService): RequestHandler {
  return (req, res, next) => {
    const token = readSessionCookie(req);
    if (!token) {
      next();
      return;
    }

    const user = auth.getUserBySession(token);
    if (!user) {
      clearSessionCookie(res);
      next();
      return;
    }

    const authenticated = req as AuthenticatedRequest;
    authenticated.user = user;
    authenticated.sessionToken = token;
    next();
  };
}

export function requireAuth(): RequestHandler {
  return (req, res, next) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).send("Authentication required");
      return;
    }
    next();
  };
}

export function requireVerifiedEmail(emailEnabled: boolean): RequestHandler {
  return (req, res, next) => {
    if (!emailEnabled) {
      next();
      return;
    }
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).send("Authentication required");
      return;
    }
    if (user.email && !user.emailVerified) {
      res.status(403).send("Email address is not verified yet");
      return;
    }
    next();
  };
}

export function createAuthGuard(authEnabled: boolean, emailEnabled = false): RequestHandler {
  if (!authEnabled) return (_req, _res, next) => next();

  const handlers = [requireAuth(), requireVerifiedEmail(emailEnabled)];
  return (req, res, next) => {
    let index = 0;
    const runNext = (): void => {
      if (index >= handlers.length) {
        next();
        return;
      }
      handlers[index]!(req, res, () => {
        index += 1;
        runNext();
      });
    };
    runNext();
  };
}

export function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  const secure = process.env.NODE_ENV === "production";
  const sameSite = process.env.NODE_ENV === "production" ? "Strict" : "Lax";
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    `Path=${SESSION_COOKIE_PATH}`,
    `SameSite=${sameSite}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === "production";
  const sameSite = process.env.NODE_ENV === "production" ? "Strict" : "Lax";
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    `Path=${SESSION_COOKIE_PATH}`,
    `SameSite=${sameSite}`,
    "Max-Age=0"
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = rest.join("=");
      return value ? decodeURIComponent(value) : undefined;
    }
  }
  return undefined;
}

export function assertOwner(
  req: AuthenticatedRequest,
  ownerUserId: string,
  res: Response,
  next: NextFunction
): boolean {
  if (!req.user || req.user.id !== ownerUserId) {
    res.status(403).send("Forbidden");
    return false;
  }
  next();
  return true;
}
