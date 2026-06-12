import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/ui/App";
import { createMockUser, jsonResponse } from "./helpers";

const apiFetchMock = vi.hoisted(() => vi.fn());
const useAuthMock = vi.hoisted(() => vi.fn());
const initialRouteRef = vi.hoisted(() => ({ current: "/" }));

vi.mock("../src/api", () => ({
  apiFetch: apiFetchMock,
  readApiError: vi.fn(async (res: Response) => (await res.text()) || res.statusText || "Request failed")
}));

vi.mock("../src/hooks/useAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hooks/useAuth")>();
  return {
    ...actual,
    useAuth: useAuthMock
  };
});

vi.mock("../src/ui/GeneratorApp", () => ({
  GeneratorApp: ({ projectId }: { projectId?: string }) => (
    <div data-testid="generator-app">{projectId ?? "new"}</div>
  )
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    BrowserRouter: ({ children }: { children: React.ReactNode }) => (
      <actual.MemoryRouter initialEntries={[initialRouteRef.current]}>{children}</actual.MemoryRouter>
    )
  };
});

function renderApp(route = "/") {
  initialRouteRef.current = route;
  return render(<App />);
}

describe("App router", () => {
  beforeEach(() => {
    apiFetchMock.mockImplementation(() => jsonResponse({ authenticated: false }));
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: false,
      refresh: vi.fn()
    });
  });

  it("renders the splash page at the root route", () => {
    renderApp("/");

    expect(screen.getByRole("heading", { name: /turn prompts into polished browser apps/i })).toBeInTheDocument();
  });

  it("renders auth pages", () => {
    renderApp("/login");
    expect(screen.getByRole("heading", { name: /log in/i })).toBeInTheDocument();

    renderApp("/register");
    expect(screen.getByRole("heading", { name: /create account/i })).toBeInTheDocument();

    renderApp("/verify-email");
    expect(screen.getByRole("heading", { name: /verify your email/i })).toBeInTheDocument();
  });

  it("protects dashboard and generator routes", async () => {
    useAuthMock.mockReturnValue({
      user: createMockUser({ emailVerified: true }),
      isLoading: false,
      refresh: vi.fn(),
      loadDashboard: vi.fn().mockResolvedValue({
        user: createMockUser({ emailVerified: true }),
        projects: [],
        history: [],
        tokenSummary: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          generationCount: 0
        }
      }),
      logout: vi.fn(),
      updateProfile: vi.fn(),
      changeEmail: vi.fn(),
      changePassword: vi.fn(),
      deleteAccount: vi.fn()
    });

    renderApp("/dashboard");
    expect(await screen.findByText(/welcome, test user/i)).toBeInTheDocument();
  });

  it("renders the generator route for verified users", async () => {
    useAuthMock.mockReturnValue({
      user: createMockUser({ emailVerified: true }),
      isLoading: false,
      refresh: vi.fn()
    });

    renderApp("/app");
    expect(await screen.findByTestId("generator-app")).toHaveTextContent("new");
  });

  it("renders the generator route with a project id", async () => {
    useAuthMock.mockReturnValue({
      user: createMockUser({ emailVerified: true }),
      isLoading: false,
      refresh: vi.fn()
    });

    renderApp("/app/proj-123");
    expect(await screen.findByTestId("generator-app")).toHaveTextContent("proj-123");
  });

  it("redirects unknown routes to the splash page", async () => {
    renderApp("/does-not-exist");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /turn prompts into polished browser apps/i })).toBeInTheDocument();
    });
  });
});
