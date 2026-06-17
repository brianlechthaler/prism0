import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { VerifyEmailPage } from "../src/ui/VerifyEmailPage";

const verifyEmailMock = vi.hoisted(() => vi.fn());
const resendVerificationMock = vi.hoisted(() => vi.fn());
const featuresMock = vi.hoisted(() => ({ loginEnabled: true, emailEnabled: true }));

vi.mock("../src/hooks/useAuth", () => ({
  useAuth: () => ({
    verifyEmail: verifyEmailMock,
    resendVerification: resendVerificationMock,
    features: featuresMock,
    isLoading: false
  })
}));

function renderVerifyEmail(path = "/verify-email", state?: { username: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, search: path.includes("?") ? path.split("?")[1] : "", state }]}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("VerifyEmailPage", () => {
  beforeEach(() => {
    verifyEmailMock.mockReset();
    resendVerificationMock.mockReset();
    featuresMock.emailEnabled = true;
  });

  it("redirects to login when email is disabled", () => {
    featuresMock.emailEnabled = false;

    render(
      <MemoryRouter initialEntries={["/verify-email"]}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("login page")).toBeInTheDocument();
  });

  it("verifies email automatically when a hash token is present", async () => {
    verifyEmailMock.mockResolvedValue(undefined);

    render(
      <MemoryRouter initialEntries={["/verify-email#token=hash-token"]}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/email verified/i)).toBeInTheDocument();
    expect(verifyEmailMock).toHaveBeenCalledWith("hash-token");
  });

  it("verifies email automatically when a query token is present", async () => {
    verifyEmailMock.mockResolvedValue(undefined);

    render(
      <MemoryRouter initialEntries={["/verify-email?token=abc123"]}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/email verified/i)).toBeInTheDocument();
    expect(verifyEmailMock).toHaveBeenCalledWith("abc123");
  });

  it("shows verification errors from the token flow", async () => {
    verifyEmailMock.mockRejectedValue(new Error("Token expired"));

    render(
      <MemoryRouter initialEntries={["/verify-email?token=bad"]}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/token expired/i)).toBeInTheDocument();
  });

  it("stringifies non-error verification failures", async () => {
    verifyEmailMock.mockRejectedValue("invalid");

    render(
      <MemoryRouter initialEntries={["/verify-email?token=bad"]}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("invalid")).toBeInTheDocument();
  });

  it("shows navigation state username in the resend form", () => {
    renderVerifyEmail("/verify-email", { username: "saved-user" });

    expect(screen.getByLabelText(/resend with username/i)).toHaveValue("saved-user");
  });

  it("resends verification email with entered credentials", async () => {
    resendVerificationMock.mockResolvedValue({ verificationToken: "dev-token" });

    renderVerifyEmail("/verify-email");

    fireEvent.change(screen.getByLabelText(/resend with username/i), { target: { value: "saved-user" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /resend verification email/i }));

    await waitFor(() => {
      expect(resendVerificationMock).toHaveBeenCalledWith("saved-user", "secret123");
      expect(screen.getByText(/dev token: dev-token/i)).toBeInTheDocument();
    });
  });

  it("shows a generic resend confirmation without a dev token", async () => {
    resendVerificationMock.mockResolvedValue({});

    renderVerifyEmail("/verify-email");

    fireEvent.change(screen.getByLabelText(/resend with username/i), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByText(/verification email resent\.$/i)).toBeInTheDocument();
  });

  it("shows resend errors", async () => {
    resendVerificationMock.mockRejectedValue(new Error("Too many requests"));

    renderVerifyEmail("/verify-email");

    fireEvent.change(screen.getByLabelText(/resend with username/i), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
  });

  it("stringifies non-error resend failures", async () => {
    resendVerificationMock.mockRejectedValue("blocked");

    renderVerifyEmail("/verify-email");

    fireEvent.change(screen.getByLabelText(/resend with username/i), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByText("blocked")).toBeInTheDocument();
  });
});
