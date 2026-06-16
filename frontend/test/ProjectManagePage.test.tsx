import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ProjectManagePage } from "../src/ui/ProjectManagePage";
import { createMockUser, jsonResponse, renderWithMatchedRoute } from "./helpers";

const apiFetchMock = vi.hoisted(() => vi.fn());
const readApiErrorMock = vi.hoisted(() => vi.fn());
const useAuthMock = vi.hoisted(() => vi.fn());

vi.mock("../src/api", () => ({
  apiFetch: apiFetchMock,
  readApiError: readApiErrorMock
}));

vi.mock("../src/hooks/useAuth", () => ({
  useAuth: useAuthMock
}));

const manageResponse = {
  project: {
    id: "proj-1",
    userId: "user-1",
    name: "Hosted App",
    slug: "hosted-app",
    editToken: "edit-token",
    currentVersionId: "v2",
    createdAt: 1,
    updatedAt: 2,
    pageViews: 12,
    publicUrl: "https://example.com/p/hosted-app",
    manageUrl: "/manage/edit-token"
  },
  versions: [
    {
      id: "v2",
      projectId: "proj-1",
      versionNumber: 2,
      idea: "add scoreboard",
      runId: "run-2",
      createdAt: 2
    },
    {
      id: "v1",
      projectId: "proj-1",
      versionNumber: 1,
      idea: null,
      runId: "run-1",
      createdAt: 1
    }
  ],
  canEdit: true
};

describe("ProjectManagePage", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    readApiErrorMock.mockReset();
    useAuthMock.mockReturnValue({ user: createMockUser() });
    apiFetchMock.mockResolvedValue(jsonResponse(manageResponse));
  });

  it("loads project details for signed-in users", async () => {
    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);

    expect(await screen.findByRole("heading", { name: /hosted app/i })).toBeInTheDocument();
    expect(screen.getByText(/12 page views/i)).toBeInTheDocument();
    expect(screen.getByText("add scoreboard")).toBeInTheDocument();
    expect(screen.getByText(/no prompt recorded/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /open editor/i })).toHaveAttribute("href", "/app/proj-1");
  });

  it("shows login navigation for anonymous viewers", async () => {
    useAuthMock.mockReturnValue({ user: null });

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);

    expect(await screen.findByRole("link", { name: /log in/i })).toHaveAttribute("href", "/login");
  });

  it("shows load errors", async () => {
    apiFetchMock.mockResolvedValue(new Response("", { status: 404 }));
    readApiErrorMock.mockResolvedValue("Project not found");

    renderWithMatchedRoute("/manage/:editToken", "/manage/missing", <ProjectManagePage />);

    expect(await screen.findByText(/project not found/i)).toBeInTheDocument();
  });

  it("shows load errors from non-error rejections", async () => {
    apiFetchMock.mockRejectedValue("offline");

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);

    expect(await screen.findByText("offline")).toBeInTheDocument();
  });

  it("shows revert errors from non-error rejections", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(manageResponse))
      .mockRejectedValueOnce("revert failed");

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);
    await screen.findByRole("heading", { name: /hosted app/i });

    fireEvent.click(screen.getAllByRole("button", { name: /revert/i })[0]);

    expect(await screen.findByText("revert failed")).toBeInTheDocument();
  });

  it("shows delete errors from non-error rejections", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(manageResponse))
      .mockRejectedValueOnce("delete failed");

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);
    await screen.findByRole("heading", { name: /hosted app/i });

    fireEvent.click(screen.getByRole("button", { name: /delete hosted project/i }));

    expect(await screen.findByText("delete failed")).toBeInTheDocument();
  });

  it("reverts to a selected version", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(manageResponse))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(manageResponse));

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);
    await screen.findByRole("heading", { name: /hosted app/i });

    fireEvent.click(screen.getAllByRole("button", { name: /revert/i })[0]);

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/manage/edit-token/revert", {
        method: "POST",
        json: { versionId: "v2" }
      });
      expect(screen.getByText(/reverted to the selected version/i)).toBeInTheDocument();
    });
  });

  it("shows revert errors", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(manageResponse))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    readApiErrorMock.mockResolvedValue("Revert failed");

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);
    await screen.findByRole("heading", { name: /hosted app/i });

    fireEvent.click(screen.getAllByRole("button", { name: /revert/i })[0]);

    expect(await screen.findByText(/revert failed/i)).toBeInTheDocument();
  });

  it("deletes the hosted project", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(manageResponse))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);
    await screen.findByRole("heading", { name: /hosted app/i });

    fireEvent.click(screen.getByRole("button", { name: /delete hosted project/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/manage/edit-token", { method: "DELETE" });
      expect(screen.getByText(/project deleted/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: /hosted app/i })).not.toBeInTheDocument();
  });

  it("shows delete errors", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(manageResponse))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    readApiErrorMock.mockResolvedValue("Delete failed");

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);
    await screen.findByRole("heading", { name: /hosted app/i });

    fireEvent.click(screen.getByRole("button", { name: /delete hosted project/i }));

    expect(await screen.findByText(/delete failed/i)).toBeInTheDocument();
  });

  it("hides edit controls when the viewer cannot edit", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        ...manageResponse,
        canEdit: false
      })
    );

    renderWithMatchedRoute("/manage/:editToken", "/manage/edit-token", <ProjectManagePage />);

    expect(await screen.findByRole("heading", { name: /hosted app/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revert/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete hosted project/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open editor/i })).not.toBeInTheDocument();
  });
});
