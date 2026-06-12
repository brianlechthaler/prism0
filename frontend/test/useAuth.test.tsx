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

describe("useAuth", () => {
  afterEach(() => {
    apiFetchMock.mockReset();
    readApiErrorMock.mockReset();
  });

  it("throws when used outside AuthProvider", () => {
    expect(() => renderHook(() => useAuth())).toThrow(/must be used within AuthProvider/i);
  });

  it("loads the current user on mount", async () => {
    const user = createMockUser();
    apiFetchMock.mockResolvedValue(jsonResponse({ authenticated: true, user }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.user).toEqual(user);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/me");
  });

  it("clears the user when the session endpoint fails", async () => {
    apiFetchMock.mockResolvedValue(new Response("", { status: 401 }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.user).toBeNull();
  });

  it("clears the user when the session is unauthenticated", async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ authenticated: false }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.user).toBeNull();
    });
  });

  it("logs in and stores the returned user", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(jsonResponse({ user: createMockUser({ username: "logged-in" }) }));

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
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    readApiErrorMock.mockResolvedValue("Invalid credentials");

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.login("bad", "creds")).rejects.toThrow("Invalid credentials");
  });

  it("registers an account without email", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(jsonResponse({}));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.register("new-user", undefined, "password123")).resolves.toEqual({});
    expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/register", {
      method: "POST",
      json: { username: "new-user", password: "password123" }
    });
  });

  it("registers an account", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(jsonResponse({ verificationToken: "dev-token" }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      result.current.register("new-user", "new@example.com", "password123")
    ).resolves.toEqual({ verificationToken: "dev-token" });
  });

  it("surfaces register failures", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(new Response("", { status: 400 }));
    readApiErrorMock.mockResolvedValue("Username taken");

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      result.current.register("new-user", "new@example.com", "password123")
    ).rejects.toThrow("Username taken");
  });

  it("logs out and clears the user", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, user: createMockUser() }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

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
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(jsonResponse(dashboard));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.loadDashboard()).resolves.toEqual(dashboard);
  });

  it("updates the profile and refreshes the user", async () => {
    const updated = createMockUser({ displayName: "Updated Name" });
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, user: createMockUser() }))
      .mockResolvedValueOnce(jsonResponse({ user: updated }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await expect(result.current.updateProfile("Updated Name")).resolves.toEqual(updated);
    });

    expect(result.current.user?.displayName).toBe("Updated Name");
  });

  it("changes email and clears the session", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, user: createMockUser() }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.changeEmail("new@example.com", "password");
    });

    expect(result.current.user).toBeNull();
  });

  it("changes password and clears the session", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, user: createMockUser() }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.changePassword("old-pass", "new-pass");
    });

    expect(result.current.user).toBeNull();
  });

  it("deletes the account and clears the session", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, user: createMockUser() }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.deleteAccount("password");
    });

    expect(result.current.user).toBeNull();
  });

  it("verifies email and stores the returned user", async () => {
    const verified = createMockUser({ emailVerified: true });
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(jsonResponse({ user: verified }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await expect(result.current.verifyEmail("token-123")).resolves.toEqual(verified);
    });

    expect(result.current.user).toEqual(verified);
  });

  it("resends verification email", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(jsonResponse({ verificationToken: "new-token" }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.resendVerification("user", "pass")).resolves.toEqual({
      verificationToken: "new-token"
    });
  });

  it("surfaces failures from protected auth actions", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValue(new Response("", { status: 500 }));
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
