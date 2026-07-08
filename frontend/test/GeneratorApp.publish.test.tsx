import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { GeneratorApp } from "../src/ui/GeneratorApp";
import { renderWithRouter } from "./helpers";

const apiFetchMock = vi.hoisted(() => vi.fn());
const readApiErrorMock = vi.hoisted(() => vi.fn());
const followUpMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());

vi.mock("../src/api", () => ({
  apiFetch: apiFetchMock,
  readApiError: readApiErrorMock
}));

vi.mock("../src/ui/EditorPreview", () => ({
  EditorPreview: () => <div data-testid="editor-preview">editor preview</div>
}));

vi.mock("../src/hooks/useGeneration", () => ({
  emptyRunStreams: () => ({ thinking: "", content: "" }),
  extractValidationErrorFromLogs: () => "",
  isYoloRun: () => false,
  useModelOptions: () => ({
    enabled: true,
    defaultModel: "model-a",
    models: ["model-a"],
    yoloModeEnabled: false,
    isLoading: false
  }),
  useGeneration: () => ({
    state: {
      kind: "ready",
      runId: "abc",
      logs: ["done"],
      streams: { thinking: "", content: "" },
      files: {
        "index.html": "<html></html>",
        "index.js": "export const x = 1;"
      }
    },
    start: startMock,
    repair: vi.fn(),
    repairValidation: vi.fn(),
    followUp: followUpMock
  })
}));

describe("GeneratorApp hosting", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    readApiErrorMock.mockReset();
    followUpMock.mockReset();
    startMock.mockReset();
  });

  it("publishes a hosted project", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          project: { publicUrl: "https://example.com/p/my-app", manageUrl: "/manage/token" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    renderWithRouter(<GeneratorApp />);

    fireEvent.change(screen.getByLabelText(/hosted project name/i), { target: { value: "My App" } });
    fireEvent.click(screen.getByRole("button", { name: /publish hosted url/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects", {
        method: "POST",
        json: { runId: "abc", name: "My App" }
      });
      expect(screen.getByText(/published at https:\/\/example.com\/p\/my-app/i)).toBeInTheDocument();
    });
  });

  it("shows publish errors", async () => {
    apiFetchMock.mockResolvedValue(new Response("", { status: 500 }));
    readApiErrorMock.mockResolvedValue("Publish failed");

    renderWithRouter(<GeneratorApp />);

    fireEvent.change(screen.getByLabelText(/hosted project name/i), { target: { value: "My App" } });
    fireEvent.click(screen.getByRole("button", { name: /publish hosted url/i }));

    expect(await screen.findByText(/publish failed/i)).toBeInTheDocument();
  });

  it("saves a hosted version for an existing project", async () => {
    apiFetchMock.mockResolvedValue(new Response("", { status: 200 }));

    renderWithRouter(<GeneratorApp projectId="proj-1" />);

    fireEvent.click(screen.getByRole("button", { name: /save hosted version/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/proj-1/versions", {
        method: "POST",
        json: { runId: "abc" }
      });
      expect(screen.getByText(/saved a new hosted version/i)).toBeInTheDocument();
    });
  });

  it("shows save-version errors", async () => {
    apiFetchMock.mockResolvedValue(new Response("", { status: 500 }));
    readApiErrorMock.mockResolvedValue("Save failed");

    renderWithRouter(<GeneratorApp projectId="proj-1" />);

    fireEvent.click(screen.getByRole("button", { name: /save hosted version/i }));

    expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
  });

  it("stringifies non-error publish failures", async () => {
    apiFetchMock.mockRejectedValue("network down");

    renderWithRouter(<GeneratorApp />);

    fireEvent.change(screen.getByLabelText(/hosted project name/i), { target: { value: "My App" } });
    fireEvent.click(screen.getByRole("button", { name: /publish hosted url/i }));

    expect(await screen.findByText("network down")).toBeInTheDocument();
  });

  it("stringifies non-error save-version failures", async () => {
    apiFetchMock.mockRejectedValue("offline");

    renderWithRouter(<GeneratorApp projectId="proj-1" />);

    fireEvent.click(screen.getByRole("button", { name: /save hosted version/i }));

    expect(await screen.findByText("offline")).toBeInTheDocument();
  });

  it("does not publish when the hosted project name is blank", async () => {
    renderWithRouter(<GeneratorApp />);

    const publishButton = screen.getByRole("button", {
      name: /publish hosted url/i
    }) as HTMLButtonElement;
    publishButton.disabled = false;
    fireEvent(
      publishButton,
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true
      })
    );

    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("passes projectId through follow-up and start requests", async () => {
    renderWithRouter(<GeneratorApp projectId="proj-1" />);

    fireEvent.change(screen.getByLabelText(/what should we add or change/i), {
      target: { value: "add particles" }
    });
    fireEvent.click(screen.getByRole("button", { name: /update app/i }));
    expect(followUpMock).toHaveBeenCalledWith("abc", "add particles", "model-a", { projectId: "proj-1" });

    fireEvent.click(screen.getByLabelText(/start a new app instead/i));
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make chess" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(startMock).toHaveBeenCalledWith("make chess", "model-a", { projectId: "proj-1" });
  });
});
