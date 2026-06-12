import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "../src/ui/ProtectedRoute";

const useAuthMock = vi.hoisted(() => vi.fn());

vi.mock("../src/hooks/useAuth", () => ({
  useAuth: useAuthMock
}));

function renderProtectedRoute(route = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <div>secret</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/verify-email" element={<div>verify page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedRoute", () => {
  beforeEach(() => {
    useAuthMock.mockReset();
  });

  it("shows a loading message while auth is loading", () => {
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: true
    });

    renderProtectedRoute();

    expect(screen.getByText(/loading your session/i)).toBeInTheDocument();
  });

  it("redirects unauthenticated users to login", () => {
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: false
    });

    renderProtectedRoute();

    expect(screen.getByText("login page")).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("redirects unverified users to verify email", () => {
    useAuthMock.mockReturnValue({
      user: {
        id: "user-1",
        username: "testuser",
        email: "test@example.com",
        emailVerified: false,
        displayName: null,
        createdAt: 1
      },
      isLoading: false
    });

    renderProtectedRoute();

    expect(screen.getByText("verify page")).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("renders children for verified users", () => {
    useAuthMock.mockReturnValue({
      user: {
        id: "user-1",
        username: "testuser",
        email: "test@example.com",
        emailVerified: true,
        displayName: null,
        createdAt: 1
      },
      isLoading: false
    });

    renderProtectedRoute();

    expect(screen.getByText("secret")).toBeInTheDocument();
  });
});
