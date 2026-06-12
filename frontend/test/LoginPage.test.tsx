import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthShell, LoginPage } from "../src/ui/LoginPage";
import { renderWithRouter } from "./helpers";

const useAuthMock = vi.hoisted(() => ({
  login: vi.fn()
}));

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("../src/hooks/useAuth", () => ({
  useAuth: () => useAuthMock
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => navigateMock
  };
});

function renderLoginAt(pathname: string, state?: { from: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname, state }]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    useAuthMock.login.mockReset();
    navigateMock.mockReset();
  });

  it("logs in and navigates to the dashboard by default", async () => {
    useAuthMock.login.mockResolvedValue(undefined);

    renderLoginAt("/login");

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(useAuthMock.login).toHaveBeenCalledWith("testuser", "secret123");
      expect(navigateMock).toHaveBeenCalledWith("/dashboard", { replace: true });
    });
  });

  it("blocks open redirects after login", async () => {
    useAuthMock.login.mockResolvedValue(undefined);

    renderLoginAt("/login", { from: "https://evil.example" });

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/dashboard", { replace: true });
    });
  });

  it("navigates to the requested route after login", async () => {
    useAuthMock.login.mockResolvedValue(undefined);

    renderLoginAt("/login", { from: "/app" });

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/app", { replace: true });
    });
  });

  it("shows login errors", async () => {
    useAuthMock.login.mockRejectedValue(new Error("Invalid credentials"));

    renderLoginAt("/login");

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "bad" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
  });

  it("stringifies non-error failures", async () => {
    useAuthMock.login.mockRejectedValue("nope");

    renderLoginAt("/login");

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "bad" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText("nope")).toBeInTheDocument();
  });
});

describe("AuthShell", () => {
  it("renders auth shell content", () => {
    renderWithRouter(
      <AuthShell title="Test title" subtitle="Test subtitle">
        <div>child content</div>
      </AuthShell>
    );

    expect(screen.getByRole("heading", { name: /test title/i })).toBeInTheDocument();
    expect(screen.getByText(/test subtitle/i)).toBeInTheDocument();
    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /prism0/i })).toHaveAttribute("href", "/");
  });
});
