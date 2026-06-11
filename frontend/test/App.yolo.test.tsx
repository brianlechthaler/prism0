import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/App";

vi.mock("../src/ui/EditorPreview", () => ({
  EditorPreview: () => <div data-testid="editor-preview">editor preview</div>
}));

vi.mock("../src/hooks/useGeneration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hooks/useGeneration")>();
  return {
    ...actual,
    useModelOptions: () => ({
      enabled: false,
      defaultModel: "model-a",
      models: [],
      yoloModeEnabled: false,
      isLoading: false
    }),
    useGeneration: () => ({
      state: {
        kind: "ready",
        runId: "abc",
        logs: [
          "done",
          "[2026-01-01T00:00:00.000Z] YOLO mode enabled for this run — validation harness will be skipped."
        ],
        streams: { thinking: "", content: "" },
        files: {
          "index.html": "<html></html>",
          "index.js": "export const x = 1;"
        }
      },
      start: vi.fn(),
      repair: vi.fn(),
      repairValidation: vi.fn(),
      followUp: vi.fn()
    })
  };
});

describe("App YOLO mode", () => {
  it("shows a post-generation warning banner for YOLO runs", async () => {
    render(<App />);
    expect(await screen.findByTestId("editor-preview")).toBeInTheDocument();
    expect(screen.getByText(/Generated without validation \(YOLO mode\)/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/The preview may crash/i);
  });
});
