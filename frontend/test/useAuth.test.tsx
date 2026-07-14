import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/hooks/useAuth";
import { createMockUser, jsonResponse } from "./helpers";

const apiFetchMock = vi.hoisted(() => vi.fn());
const readApiErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../src/api", () => ({
  apiFetch: apiFetchMock,
  readApiError: readApiErrorMock
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

type ApiHandler = (url: string, options?: RequestInit) => Response | Promise<Response>;

function setupApiMock(
  handlers: Record<string, ApiHandler | Response>,
  features: { loginEnabled: boolean; emailEnabled: boolean } = {
    loginEnabled: false,
    emailEnabled: false
  }
) {
  apiFetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if (url === "/api/auth/features") {
      return Promise.resolve(jsonResponse(features));
    }
    const handler = handlers[url];
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    return Promise.resolve(typeof handler === "function" ? handler(url, options) : handler);
  });
}

describe("useAuth", () => {
  afterEach(() => {
    apiFetchMock.mockReset();
    readApiErrorMock.mockReset();
  });

  it("throws when used outside AuthProvider", () => {
    expect(() => renderHook(() => useAuth())).toThrow(/must be used within AuthProvider/i);
  });

  it("loads auth features and the current user on mount", async () => {
    const user = createMockUser();
    setupApiMock(
      {
        "/api/auth/me": jsonResponse({ authenticated: true, user })
      },
      { loginEnabled: true, emailEnabled: true }
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.user).toEqual(user);
    expect(result.current.features).toEqual({ loginEnabled: true, emailEnabled: true });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/features");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/me");
  });

  it("clears the user when the session endpoint fails", async () => {
    setupApiMock({
      "/api/auth/me": new Response("", { status: 401 })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.user).toBeNull();
  });

  it("clears the user when the session is unauthenticated", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.user).toBeNull();
    });
  });

  it("logs in and stores the returned user", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/auth/login": jsonResponse({ user: createMockUser({ username: "logged-in" }) })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.login("logged-in", "secret");
    });

    expect(result.current.user?.username).toBe("logged-in");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      json: { username: "logged-in", password: "secret" }
    });
  });

  it("surfaces login failures", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/auth/login": new Response("", { status: 401 })
    });
    readApiErrorMock.mockResolvedValue("Invalid credentials");

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.login("bad", "creds")).rejects.toThrow("Invalid credentials");
  });

  it("registers an account without email", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/auth/register": jsonResponse({})
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.register("new-user", undefined, "securepass12")).resolves.toEqual({});
    expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/register", {
      method: "POST",
      json: { username: "new-user", password: "securepass12" }
    });
  });

  it("registers an account", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/auth/register": jsonResponse({ verificationToken: "dev-token" })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      result.current.register("new-user", "new@example.com", "securepass12")
    ).resolves.toEqual({ verificationToken: "dev-token" });
  });

  it("surfaces register failures", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/auth/register": new Response("", { status: 400 })
    });
    readApiErrorMock.mockResolvedValue("Username taken");

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      result.current.register("new-user", "new@example.com", "securepass12")
    ).rejects.toThrow("Username taken");
  });

  it("logs out and clears the user", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: true, user: createMockUser() }),
      "/api/auth/logout": new Response("", { status: 200 })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.user).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
  });

  it("loads dashboard data", async () => {
    const dashboard = {
      user: createMockUser(),
      projects: [],
      history: [],
      tokenSummary: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        generationCount: 1
      }
    };
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/dashboard": jsonResponse(dashboard)
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.loadDashboard()).resolves.toEqual(dashboard);
  });

  it("updates the profile and refreshes the user", async () => {
    const updated = createMockUser({ displayName: "Updated Name" });
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: true, user: createMockUser() }),
      "/api/auth/profile": jsonResponse({ user: updated })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await expect(result.current.updateProfile("Updated Name")).resolves.toEqual(updated);
    });

    expect(result.current.user?.displayName).toBe("Updated Name");
  });

  it("changes email and clears the session", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: true, user: createMockUser() }),
      "/api/auth/change-email": new Response("", { status: 200 })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.changeEmail("new@example.com", "password");
    });

    expect(result.current.user).toBeNull();
  });

  it("changes password and clears the session", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: true, user: createMockUser() }),
      "/api/auth/change-password": new Response("", { status: 200 })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.changePassword("old-pass", "new-pass");
    });

    expect(result.current.user).toBeNull();
  });

  it("deletes the account and clears the session", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: true, user: createMockUser() }),
      "/api/auth/account": new Response("", { status: 200 })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.deleteAccount("password");
    });

    expect(result.current.user).toBeNull();
  });

  it("verifies email and stores the returned user", async () => {
    const verified = createMockUser({ emailVerified: true });
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/auth/verify-email": jsonResponse({ user: verified })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await expect(result.current.verifyEmail("token-123")).resolves.toEqual(verified);
    });

    expect(result.current.user).toEqual(verified);
  });

  it("resends verification email", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/auth/resend-verification": jsonResponse({ verificationToken: "new-token" })
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.resendVerification("user", "pass")).resolves.toEqual({
      verificationToken: "new-token"
    });
  });

  it("surfaces failures from protected auth actions", async () => {
    setupApiMock({
      "/api/auth/me": jsonResponse({ authenticated: false }),
      "/api/dashboard": new Response("", { status: 500 }),
      "/api/auth/profile": new Response("", { status: 500 }),
      "/api/auth/change-email": new Response("", { status: 500 }),
      "/api/auth/change-password": new Response("", { status: 500 }),
      "/api/auth/account": new Response("", { status: 500 }),
      "/api/auth/verify-email": new Response("", { status: 500 }),
      "/api/auth/resend-verification": new Response("", { status: 500 })
    });
    readApiErrorMock.mockResolvedValue("Server error");

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.loadDashboard()).rejects.toThrow("Server error");
    await expect(result.current.updateProfile("Name")).rejects.toThrow("Server error");
    await expect(result.current.changeEmail("a@b.com", "pass")).rejects.toThrow("Server error");
    await expect(result.current.changePassword("old", "new")).rejects.toThrow("Server error");
    await expect(result.current.deleteAccount("pass")).rejects.toThrow("Server error");
    await expect(result.current.verifyEmail("bad")).rejects.toThrow("Server error");
    await expect(result.current.resendVerification("user", "pass")).rejects.toThrow("Server error");
  });
});
