import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProgressPanel } from "../src/ui/ProgressPanel";

describe("ProgressPanel", () => {
  it("renders activity, thinking, content, and validation sections", () => {
    render(
      <ProgressPanel
        logs={[
          "Run started",
          "[2026-01-01T00:00:00.000Z] [validation] Running ESLint on generated sources…",
          "[2026-01-01T00:00:00.000Z] [validation] [eslint] [stdout] all good"
        ]}
        streams={{ thinking: "plan the app", content: '{"summary":"app"}' }}
      />
    );

    expect(screen.getByText("Run started")).toBeInTheDocument();
    expect(screen.getByText("plan the app")).toBeInTheDocument();
    expect(screen.getByText('{"summary":"app"}')).toBeInTheDocument();
    expect(screen.getByText(/Running ESLint on generated sources/i)).toBeInTheDocument();
  });

  it("shows validation skipped copy for YOLO runs", () => {
    render(
      <ProgressPanel
        logs={[
          "Run started",
          "[2026-01-01T00:00:00.000Z] YOLO mode: skipping validation harness (lint/tests). Results may be unsafe or broken."
        ]}
        streams={{ thinking: "", content: "" }}
      />
    );

    expect(screen.getByText(/YOLO mode: skipping validation harness/i)).toBeInTheDocument();
  });

  it("shows validation skipped placeholder before YOLO logs arrive", () => {
    render(
      <ProgressPanel
        logs={["Run started", "[2026-01-01T00:00:00.000Z] YOLO mode enabled for this run — validation harness will be skipped."]}
        streams={{ thinking: "", content: "" }}
      />
    );
    expect(screen.getByText(/Validation skipped \(YOLO mode\)/i)).toBeInTheDocument();
  });

  it("shows default activity placeholder when logs are empty", () => {
    render(<ProgressPanel logs={[]} streams={{ thinking: "", content: "" }} />);
    expect(screen.getByText("Waiting for progress…")).toBeInTheDocument();
  });

  it("shows empty-state copy for thinking and content streams", () => {
    render(<ProgressPanel logs={["Run started"]} streams={{ thinking: "", content: "" }} />);
    expect(
      screen.getByText("Reasoning tokens from the model will appear here when available.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("The model's JSON/code output will stream here as it is generated.")
    ).toBeInTheDocument();
  });
});
