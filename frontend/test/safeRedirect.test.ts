import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "../src/safeRedirect";

describe("safeRedirectPath", () => {
  it("allows internal paths", () => {
    expect(safeRedirectPath("/dashboard")).toBe("/dashboard");
    expect(safeRedirectPath("/app")).toBe("/app");
    expect(safeRedirectPath("/manage/token")).toBe("/manage/token");
  });

  it("rejects external and protocol-relative redirects", () => {
    expect(safeRedirectPath("https://evil.example")).toBe("/dashboard");
    expect(safeRedirectPath("//evil.example")).toBe("/dashboard");
    expect(safeRedirectPath("/\\evil")).toBe("/dashboard");
    expect(safeRedirectPath("/path://evil")).toBe("/dashboard");
  });

  it("falls back for invalid values", () => {
    expect(safeRedirectPath(undefined)).toBe("/dashboard");
    expect(safeRedirectPath("")).toBe("/dashboard");
    expect(safeRedirectPath(null)).toBe("/dashboard");
    expect(safeRedirectPath("/custom", "/app")).toBe("/custom");
  });
});
