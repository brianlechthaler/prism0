import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  clientRateLimitKey,
  createAuthRateLimitGuard,
  LoginFailureTracker
} from "../src/authRateLimit.js";
import { testConfig } from "./helpers.js";

function mockReq(ip?: string): Request {
  return {
    ip,
    socket: { remoteAddress: ip ?? "127.0.0.1" }
  } as Request;
}

function mockRes() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body = "";
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    send(message: string) {
      body = message;
      return res;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
    }
  } as unknown as Response;
  return { res, headers, get statusCode() { return statusCode; }, get body() { return body; } };
}

describe("authRateLimit", () => {
  it("uses request ip for rate-limit keys", () => {
    expect(clientRateLimitKey(mockReq("10.0.0.5"))).toBe("10.0.0.5");
    expect(clientRateLimitKey({ socket: { remoteAddress: "10.0.0.6" } } as Request)).toBe("10.0.0.6");
    expect(clientRateLimitKey({ socket: {} } as Request)).toBe("unknown");
  });

  it("blocks auth requests after the configured limit", () => {
    let now = 1_000_000;
    const guard = createAuthRateLimitGuard(
      { ...testConfig, authRateLimitMax: 2, authRateLimitWindowMs: 60_000 },
      () => now
    );
    const next = vi.fn();

    guard(mockReq(), mockRes().res, next);
    guard(mockReq(), mockRes().res, next);
    expect(next).toHaveBeenCalledTimes(2);

    const blocked = mockRes();
    guard(mockReq(), blocked.res, next);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain("Too many authentication requests");
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("resets auth rate-limit buckets after the window", () => {
    let now = 1_000_000;
    const guard = createAuthRateLimitGuard(
      { ...testConfig, authRateLimitMax: 1, authRateLimitWindowMs: 1_000 },
      () => now
    );
    const next = vi.fn();

    guard(mockReq(), mockRes().res, next);
    const blocked = mockRes();
    guard(mockReq(), blocked.res, next);
    expect(blocked.statusCode).toBe(429);

    now += 1_001;
    guard(mockReq(), mockRes().res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("tracks login failures and clears expired lockouts", () => {
    let now = 1_000_000;
    const tracker = new LoginFailureTracker(2, 5_000, () => now);

    expect(tracker.isLocked("User")).toBe(false);
    tracker.recordFailure("user");
    expect(tracker.isLocked("user")).toBe(false);
    tracker.recordFailure("USER");
    expect(tracker.isLocked("user")).toBe(true);
    expect(tracker.lockoutRetryAfterSeconds("user")).toBeGreaterThan(0);

    tracker.clear("user");
    expect(tracker.isLocked("user")).toBe(false);

    tracker.recordFailure("user");
    tracker.recordFailure("user");
    now += 5_001;
    expect(tracker.isLocked("user")).toBe(false);
    expect(tracker.lockoutRetryAfterSeconds("user")).toBe(0);

    tracker.recordFailure("user");
    expect(tracker.isLocked("user")).toBe(false);
  });

  it("restarts failure count when recording after an expired lockout", () => {
    let now = 1_000_000;
    const tracker = new LoginFailureTracker(2, 5_000, () => now);

    tracker.recordFailure("user");
    tracker.recordFailure("user");
    now += 5_001;
    tracker.recordFailure("user");
    expect(tracker.isLocked("user")).toBe(false);
  });

  it("keeps incrementing failures while the account is locked", () => {
    let now = 1_000_000;
    const tracker = new LoginFailureTracker(2, 5_000, () => now);

    tracker.recordFailure("user");
    tracker.recordFailure("user");
    expect(tracker.isLocked("user")).toBe(true);

    tracker.recordFailure("user");
    expect(tracker.isLocked("user")).toBe(true);
  });
});
