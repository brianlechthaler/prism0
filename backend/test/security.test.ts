import { describe, expect, it } from "vitest";
import {
  hostedContentSecurityPolicy,
  redactUrlForLogs,
  sanitizeClientError,
  spaContentSecurityPolicy,
  validatePassword
} from "../src/security.js";

describe("security helpers", () => {
  it("validates password length and common passwords", () => {
    expect(validatePassword("short")).toMatch(/at least 12/);
    expect(validatePassword("securepass12")).toBeUndefined();
    expect(validatePassword("123456789012")).toMatch(/too common/);
    expect(validatePassword("x".repeat(201))).toMatch(/200 characters/);
  });

  it("sanitizes client-facing error messages", () => {
    const message = "Request failed with sk-abcdefghijklmnopqrstuvwxyz and Bearer secret-token";
    expect(sanitizeClientError(message)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(sanitizeClientError(message)).toContain("[redacted]");
  });

  it("redacts sensitive URL parts for logs", () => {
    expect(redactUrlForLogs("https://api.example.com/v1/secret?key=1")).toBe("https://api.example.com");
    expect(redactUrlForLogs("not-a-url")).toBe("[invalid-url]");
  });

  it("builds CSP policies", () => {
    expect(spaContentSecurityPolicy()).toContain("default-src 'self'");
    expect(hostedContentSecurityPolicy()).toContain("unsafe-inline");
  });
});
