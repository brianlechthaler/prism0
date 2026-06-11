import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/App";

vi.mock("../src/hooks/useGeneration", () => ({
  emptyRunStreams: () => ({ thinking: "", content: "" }),
  extractValidationErrorFromLogs: () => "",
  useModelOptions: () => ({
    enabled: true,
    defaultModel: "model-a",
    models: ["model-a", "model-b"],
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
    start: vi.fn(),
    repair: vi.fn()
  })
}));

describe("App generating state", () => {
  it("disables submit and shows progress label", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /generating/i })).toBeDisabled();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("20.0 tok/s")).toBeInTheDocument();
    expect(screen.getByText(/140 \/ 1,000 context tokens \(14.0%\)/i)).toBeInTheDocument();
  });
});
