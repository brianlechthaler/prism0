import type { Request, RequestHandler } from "express";
import type { AppConfig } from "./config.js";

export type RateBucket = { count: number; resetAt: number };

export function clientRateLimitKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function createAuthRateLimitGuard(
  config: AppConfig,
  now: () => number = Date.now
): RequestHandler {
  const buckets = new Map<string, RateBucket>();

  return (req, res, next) => {
    const currentTime = now();
    const key = clientRateLimitKey(req);
    const existing = buckets.get(key);
    const bucket =
      existing && existing.resetAt > currentTime
        ? existing
        : { count: 0, resetAt: currentTime + config.authRateLimitWindowMs };

    if (bucket.count >= config.authRateLimitMax) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - currentTime) / 1000)));
      res.status(429).send("Too many authentication requests; try again later");
      buckets.set(key, bucket);
      return;
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    next();
  };
}

export class LoginFailureTracker {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly lockoutMs: number,
    private readonly now: () => number = Date.now
  ) {}

  normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  isLocked(username: string): boolean {
    const key = this.normalizeUsername(username);
    const entry = this.failures.get(key);
    if (!entry || entry.lockedUntil === 0) return false;
    if (entry.lockedUntil <= this.now()) {
      this.failures.delete(key);
      return false;
    }
    return true;
  }

  lockoutRetryAfterSeconds(username: string): number {
    const entry = this.failures.get(this.normalizeUsername(username));
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.lockedUntil - this.now()) / 1000));
  }

  recordFailure(username: string): void {
    const key = this.normalizeUsername(username);
    const currentTime = this.now();
    const entry = this.failures.get(key);

    let count = 1;
    if (entry) {
      if (entry.lockedUntil === 0 || entry.lockedUntil > currentTime) {
        count = entry.count + 1;
      }
    }

    const lockedUntil = count >= this.maxFailures ? currentTime + this.lockoutMs : 0;
    this.failures.set(key, { count, lockedUntil });
  }

  clear(username: string): void {
    this.failures.delete(this.normalizeUsername(username));
  }
}
