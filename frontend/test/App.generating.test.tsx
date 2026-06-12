import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { GeneratorApp } from "../src/ui/GeneratorApp";
import { renderWithRouter } from "./helpers";

const mocks = vi.hoisted(() => ({
  start: vi.fn()
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
      kind: "generating",
      runId: "abc",
      logs: ["working"],
      streams: { thinking: "", content: "" },
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        contextWindowTokens: 1000,
        contextUsedTokens: 140,
        contextUsedPercent: 14,
        outputTokensPerSecond: 20,
        buckets: [
          {
            kind: "generate",
            label: "LLM generate",
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140
          }
        ]
      }
    },
    start: mocks.start,
    repair: vi.fn()
  })
}));

describe("GeneratorApp generating state", () => {
  beforeEach(() => {
    mocks.start.mockClear();
  });

  it("disables submit and shows progress label", () => {
    renderWithRouter(<GeneratorApp />);
    expect(screen.getByRole("button", { name: /generating/i })).toBeDisabled();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("20.0 tok/s")).toBeInTheDocument();
    expect(screen.getByText(/140 \/ 1,000 context tokens \(14.0%\)/i)).toBeInTheDocument();
  });

  it("does not submit when shift+enter is pressed while generating", () => {
    renderWithRouter(<GeneratorApp />);
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.keyDown(ideaField, { key: "Enter", shiftKey: true });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
