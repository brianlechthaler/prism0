import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RegisterPage } from "../src/ui/RegisterPage";
import { renderWithRouter } from "./helpers";

const registerMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const featuresMock = vi.hoisted(() => ({ loginEnabled: true, emailEnabled: true }));

vi.mock("../src/hooks/useAuth", () => ({
  useAuth: () => ({ register: registerMock, features: featuresMock, isLoading: false })
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => navigateMock
  };
});

describe("RegisterPage", () => {
  beforeEach(() => {
    registerMock.mockReset();
    navigateMock.mockReset();
    featuresMock.loginEnabled = true;
    featuresMock.emailEnabled = true;
  });

  it("redirects to the generator when login is disabled", () => {
    featuresMock.loginEnabled = false;

    render(
      <MemoryRouter initialEntries={["/register"]}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/app" element={<div>generator</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("generator")).toBeInTheDocument();
  });

  it("creates an account without email fields when email is disabled", async () => {
    featuresMock.emailEnabled = false;
    registerMock.mockResolvedValue({});

    renderWithRouter(<RegisterPage />);

    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "newbie" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith("newbie", undefined, "password123");
      expect(navigateMock).toHaveBeenCalledWith("/login", {
        replace: true,
        state: { message: "Account created. Log in to continue." }
      });
    });
  });

  it("creates an account without email and navigates to login", async () => {
    registerMock.mockResolvedValue({});

    renderWithRouter(<RegisterPage />);

    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "newbie" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith("newbie", undefined, "password123");
      expect(navigateMock).toHaveBeenCalledWith("/login", {
        replace: true,
        state: { message: "Account created. Log in to continue." }
      });
    });
  });

  it("creates an account and navigates to verify email", async () => {
    registerMock.mockResolvedValue({ verificationToken: "dev-token" });

    renderWithRouter(<RegisterPage />);

    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "newbie" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith("newbie", "new@example.com", "password123");
      expect(navigateMock).toHaveBeenCalledWith("/verify-email", {
        replace: true,
        state: { username: "newbie", verificationToken: "dev-token" }
      });
    });
  });

  it("shows registration errors", async () => {
    registerMock.mockRejectedValue(new Error("Username taken"));

    renderWithRouter(<RegisterPage />);

    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "newbie" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/username taken/i)).toBeInTheDocument();
  });

  it("stringifies non-error registration failures", async () => {
    registerMock.mockRejectedValue("failed");

    renderWithRouter(<RegisterPage />);

    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "newbie" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText("failed")).toBeInTheDocument();
  });
});
