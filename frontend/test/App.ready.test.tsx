import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/ui/App";

const { followUp, repair, repairValidation, start } = vi.hoisted(() => ({
  followUp: vi.fn(),
  repair: vi.fn(),
  repairValidation: vi.fn(),
  start: vi.fn()
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
    models: ["model-a", "model-b"],
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
        "index.js": "export const x = 1;",
        "styles.css": "body {}",
        "index.test.js": "test",
        "package.json": "{}"
      }
    },
    start,
    repair,
    repairValidation,
    followUp
  })
}));

describe("App ready state", () => {
  beforeEach(() => {
    followUp.mockClear();
    repair.mockClear();
    repairValidation.mockClear();
    start.mockClear();
  });

  it("shows download link and editor preview", async () => {
    render(<App />);
    expect(screen.getByText(/download zip/i)).toBeInTheDocument();
    expect(await screen.findByTestId("editor-preview")).toBeInTheDocument();
  });

  it("submits ready-state prompts as follow-up changes by default", async () => {
    render(<App />);
    const prompt = screen.getByLabelText(/what should we add or change/i);
    fireEvent.change(prompt, { target: { value: "add a settings panel" } });
    fireEvent.click(screen.getByRole("button", { name: /update app/i }));

    expect(followUp).toHaveBeenCalledWith("abc", "add a settings panel", "model-a", undefined);
    expect(start).not.toHaveBeenCalled();
  });

  it("expands ready-state follow-up prompts with follow-up placeholder text", async () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText(/what should we add or change/i));
    const prompt = screen.getByLabelText(/what should we add or change/i);
    expect(prompt.tagName).toBe("TEXTAREA");
    expect(prompt).toHaveAttribute(
      "placeholder",
      'e.g. "add keyboard controls and a score history"'
    );
  });

  it("can use ready-state prompts to start a new app instead", async () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText(/start a new app instead/i));
    const prompt = screen.getByLabelText(/what should we build/i);
    fireEvent.change(prompt, { target: { value: "make a drawing app" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(start).toHaveBeenCalledWith("make a drawing app", "model-a", undefined);
    expect(followUp).not.toHaveBeenCalled();
  });

  it("can switch back to follow-up mode after choosing a new app", async () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText(/start a new app instead/i));
    fireEvent.click(screen.getByLabelText(/update the current app/i));
    const prompt = screen.getByLabelText(/what should we add or change/i);
    fireEvent.change(prompt, { target: { value: "add keyboard shortcuts" } });
    fireEvent.click(screen.getByRole("button", { name: /update app/i }));

    expect(followUp).toHaveBeenCalledWith("abc", "add keyboard shortcuts", "model-a", undefined);
    expect(start).not.toHaveBeenCalled();
  });
});
