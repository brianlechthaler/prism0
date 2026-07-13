import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { GeneratorApp } from "../src/ui/GeneratorApp";
import { renderWithRouter } from "./helpers";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  onBundlerError: null as ((message: string) => void) | null
}));

vi.mock("../src/ui/EditorPreview", () => ({
  EditorPreview: ({
    onBundlerError
  }: {
    onBundlerError?: (message: string) => void;
  }) => {
    mocks.onBundlerError = onBundlerError ?? null;
    return <div data-testid="editor-preview">editor preview</div>;
  }
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
      runId: "r1",
      logs: ["ready"],
      streams: { thinking: "", content: "" },
      files: {
        "index.html": "<html></html>",
        "index.js": "export const x = 1;"
      }
    },
    start: vi.fn(),
    repair: mocks.repair,
    repairValidation: vi.fn(),
    followUp: vi.fn()
  })
}));

describe("GeneratorApp ready-state preview errors", () => {
  beforeEach(() => {
    mocks.repair.mockReset();
    mocks.onBundlerError = null;
  });

  it("shows a repair button when Sandpack reports a bundler error", async () => {
    renderWithRouter(<GeneratorApp />);
    expect(await screen.findByTestId("editor-preview")).toBeInTheDocument();

    act(() => {
      mocks.onBundlerError?.("SyntaxError: Unexpected token\nLocation: /index.js:1:1");
    });

    expect(await screen.findByText(/generated app has an error/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /fix with llm/i }));

    await waitFor(() => {
      expect(mocks.repair).toHaveBeenCalledWith(
        "r1",
        "SyntaxError: Unexpected token\nLocation: /index.js:1:1",
        "model-a"
      );
    });
  });

  it("ignores preview runtime errors from other origins", async () => {
    renderWithRouter(<GeneratorApp />);
    expect(await screen.findByTestId("editor-preview")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://evil.example",
          data: {
            type: "prism0-preview-error",
            runId: "r1",
            message: "should be ignored"
          }
        })
      );
    });

    expect(screen.queryByText(/generated app has an error/i)).not.toBeInTheDocument();
  });
});
