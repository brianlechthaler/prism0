import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { DashboardPage } from "../src/ui/DashboardPage";
import { createMockUser, renderWithRouter } from "./helpers";

const authMocks = vi.hoisted(() => ({
  user: {
    id: "user-1",
    username: "testuser",
    email: "test@example.com",
    emailVerified: true,
    displayName: "Test User",
    createdAt: 1
  },
  features: { loginEnabled: true, emailEnabled: true },
  loadDashboard: vi.fn(),
  logout: vi.fn(),
  updateProfile: vi.fn(),
  changeEmail: vi.fn(),
  changePassword: vi.fn(),
  deleteAccount: vi.fn()
}));

vi.mock("../src/hooks/useAuth", () => ({
  useAuth: () => authMocks
}));

const dashboardData = {
  user: createMockUser(),
  projects: [
    {
      id: "proj-1",
      userId: "user-1",
      name: "My App",
      slug: "my-app",
      editToken: "edit-token",
      currentVersionId: "v1",
      createdAt: 1,
      updatedAt: 2,
      pageViews: 42,
      publicUrl: "https://example.com/p/my-app",
      manageUrl: "/manage/edit-token"
    }
  ],
  history: [
    {
      id: "hist-1",
      userId: "user-1",
      projectId: "proj-1",
      runId: "run-1",
      idea: "make pong",
      status: "ready",
      inputTokens: 10,
      outputTokens: 20,
      createdAt: 1,
      updatedAt: 2
    }
  ],
  tokenSummary: {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    generationCount: 1
  }
};

describe("DashboardPage", () => {
  beforeEach(() => {
    authMocks.user = createMockUser();
    authMocks.loadDashboard.mockReset();
    authMocks.logout.mockReset();
    authMocks.updateProfile.mockReset();
    authMocks.changeEmail.mockReset();
    authMocks.changePassword.mockReset();
    authMocks.deleteAccount.mockReset();
    authMocks.loadDashboard.mockResolvedValue(dashboardData);
  });

  it("renders dashboard data, projects, and history", async () => {
    renderWithRouter(<DashboardPage />);

    expect(await screen.findByText(/welcome, test user/i)).toBeInTheDocument();
    expect(screen.getByText(/30 total across 1 runs/i)).toBeInTheDocument();
    expect(screen.getByText("My App")).toBeInTheDocument();
    expect(screen.getByText(/42 page views/i)).toBeInTheDocument();
    expect(screen.getByText("make pong")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open site/i })).toHaveAttribute(
      "href",
      "https://example.com/p/my-app"
    );
  });

  it("shows placeholders and username fallback when dashboard data is empty", async () => {
    authMocks.user = createMockUser({ displayName: null });
    authMocks.loadDashboard.mockResolvedValue({
      ...dashboardData,
      projects: [],
      history: []
    });

    renderWithRouter(<DashboardPage />);

    expect(await screen.findByText(/welcome, testuser/i)).toBeInTheDocument();
    expect(screen.getByText(/no hosted projects yet/i)).toBeInTheDocument();
    expect(screen.getByText(/your chat history will appear here/i)).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    authMocks.loadDashboard.mockRejectedValue(new Error("Dashboard unavailable"));

    renderWithRouter(<DashboardPage />);

    expect(await screen.findByText(/dashboard unavailable/i)).toBeInTheDocument();
  });

  it("updates profile settings", async () => {
    authMocks.updateProfile.mockResolvedValue(createMockUser({ displayName: "New Name" }));

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: /save display name/i }));

    await waitFor(() => {
      expect(authMocks.updateProfile).toHaveBeenCalledWith("New Name");
      expect(screen.getByText(/profile updated/i)).toBeInTheDocument();
    });
  });

  it("shows load errors from non-error rejections", async () => {
    authMocks.loadDashboard.mockRejectedValue("offline");

    renderWithRouter(<DashboardPage />);

    expect(await screen.findByText("offline")).toBeInTheDocument();
  });

  it("shows profile update errors", async () => {
    authMocks.updateProfile.mockRejectedValue(new Error("Profile failed"));

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.click(screen.getByRole("button", { name: /save display name/i }));

    expect(await screen.findByText(/profile failed/i)).toBeInTheDocument();
  });

  it("shows profile update errors from non-error rejections", async () => {
    authMocks.updateProfile.mockRejectedValue("profile failed");

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.click(screen.getByRole("button", { name: /save display name/i }));

    expect(await screen.findByText("profile failed")).toBeInTheDocument();
  });

  it("clears an empty display name before saving", async () => {
    authMocks.updateProfile.mockResolvedValue(createMockUser({ displayName: null }));

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /save display name/i }));

    await waitFor(() => {
      expect(authMocks.updateProfile).toHaveBeenCalledWith(null);
    });
  });

  it("shows add-email messaging for accounts without an address", async () => {
    authMocks.user = createMockUser({ email: null });
    authMocks.loadDashboard.mockResolvedValue({
      ...dashboardData,
      user: createMockUser({ email: null })
    });
    authMocks.changeEmail.mockResolvedValue(undefined);

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    expect(screen.getByLabelText(/add email/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/add email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getAllByPlaceholderText(/current password/i)[0], {
      target: { value: "secret123" }
    });
    fireEvent.click(screen.getByRole("button", { name: /update email/i }));

    expect(await screen.findByText(/email added/i)).toBeInTheDocument();
  });

  it("handles email, password, and account deletion flows", async () => {
    authMocks.changeEmail.mockResolvedValue(undefined);
    authMocks.changePassword.mockResolvedValue(undefined);
    authMocks.deleteAccount.mockResolvedValue(undefined);

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.change(screen.getByLabelText(/change email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getAllByPlaceholderText(/current password/i)[0], {
      target: { value: "secret123" }
    });
    fireEvent.click(screen.getByRole("button", { name: /update email/i }));

    expect(await screen.findByText(/verify your new address/i)).toBeInTheDocument();

    fireEvent.change(screen.getAllByPlaceholderText(/current password/i)[1], {
      target: { value: "secret123" }
    });
    fireEvent.change(screen.getByPlaceholderText(/new password/i), { target: { value: "new-pass" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText(/password changed/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/delete account/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /^delete account$/i }));

    expect(await screen.findByText(/account deleted/i)).toBeInTheDocument();
  });

  it("shows account management errors for Error rejections", async () => {
    authMocks.changeEmail.mockRejectedValue(new Error("email failed"));
    authMocks.deleteAccount.mockRejectedValue(new Error("delete failed"));

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.change(screen.getByLabelText(/change email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getAllByPlaceholderText(/current password/i)[0], {
      target: { value: "secret123" }
    });
    fireEvent.click(screen.getByRole("button", { name: /update email/i }));
    expect(await screen.findByText(/email failed/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/delete account/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /^delete account$/i }));
    expect(await screen.findByText(/delete failed/i)).toBeInTheDocument();
  });

  it("shows password update errors from non-error rejections", async () => {
    authMocks.changePassword.mockRejectedValue("password failed");

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.change(screen.getAllByPlaceholderText(/current password/i)[1], {
      target: { value: "secret123" }
    });
    fireEvent.change(screen.getByPlaceholderText(/new password/i), { target: { value: "new-pass" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText("password failed")).toBeInTheDocument();
  });

  it("shows errors from account management actions", async () => {
    authMocks.changeEmail.mockRejectedValue("email failed");
    authMocks.changePassword.mockRejectedValue(new Error("password failed"));
    authMocks.deleteAccount.mockRejectedValue("delete failed");

    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.change(screen.getByLabelText(/change email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getAllByPlaceholderText(/current password/i)[0], {
      target: { value: "secret123" }
    });
    fireEvent.click(screen.getByRole("button", { name: /update email/i }));
    expect(await screen.findByText("email failed")).toBeInTheDocument();

    fireEvent.change(screen.getAllByPlaceholderText(/current password/i)[1], {
      target: { value: "secret123" }
    });
    fireEvent.change(screen.getByPlaceholderText(/new password/i), { target: { value: "new-pass" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText(/password failed/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/delete account/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /^delete account$/i }));
    expect(await screen.findByText("delete failed")).toBeInTheDocument();
  });

  it("logs out from the header", async () => {
    renderWithRouter(<DashboardPage />);
    await screen.findByText(/welcome, test user/i);

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    expect(authMocks.logout).toHaveBeenCalled();
  });

  it("welcomes users without a loaded profile name", async () => {
    authMocks.user = null;
    authMocks.loadDashboard.mockResolvedValue({
      ...dashboardData,
      user: createMockUser({ displayName: null, username: "solo" })
    });

    renderWithRouter(<DashboardPage />);

    expect(await screen.findByText(/^Welcome$/)).toBeInTheDocument();
  });
});
