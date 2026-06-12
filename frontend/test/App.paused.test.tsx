import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { GeneratorApp } from "../src/ui/GeneratorApp";
import { renderWithRouter } from "./helpers";

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  restart: vi.fn()
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
      kind: "paused",
      runId: "paused-1",
      logs: ["working", "Paused."],
      streams: { thinking: "plan", content: "{" },
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        contextWindowTokens: 1000,
        contextUsedTokens: 140,
        contextUsedPercent: 14,
        outputTokensPerSecond: 20,
        buckets: []
      }
    },
    start: vi.fn(),
    stop: mocks.stop,
    pause: mocks.pause,
    resume: mocks.resume,
    restart: mocks.restart,
    repair: vi.fn(),
    repairValidation: vi.fn(),
    followUp: vi.fn()
  })
}));

describe("GeneratorApp paused state", () => {
  beforeEach(() => {
    mocks.stop.mockClear();
    mocks.pause.mockClear();
    mocks.resume.mockClear();
    mocks.restart.mockClear();
  });

  it("shows resume and restart controls while paused", () => {
    renderWithRouter(<GeneratorApp />);
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(mocks.resume).toHaveBeenCalledWith("paused-1");

    fireEvent.click(screen.getByRole("button", { name: /restart/i }));
    expect(mocks.restart).toHaveBeenCalledWith("make a tiny tetris-like game", "model-a", undefined);
  });

  it("passes projectId when restarting an app edit session", () => {
    renderWithRouter(<GeneratorApp projectId="project-123" />);
    fireEvent.click(screen.getByRole("button", { name: /restart/i }));
    expect(mocks.restart).toHaveBeenCalledWith("make a tiny tetris-like game", "model-a", {
      projectId: "project-123"
    });
  });
});
