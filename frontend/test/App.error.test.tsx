import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, PREVIEW_ERROR_MESSAGE_TYPE, withPreviewErrorReporter } from "../src/ui/App";
import type { GenerationState } from "../src/hooks/useGeneration";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  start: vi.fn(),
  state: {
    kind: "error",
    message: "something broke",
    logs: ["failed"]
  } as GenerationState
}));

vi.mock("@codesandbox/sandpack-react", () => ({
  Sandpack: () => null
}));

vi.mock("../src/hooks/useGeneration", () => ({
  useGeneration: () => ({
    state: mocks.state,
    start: mocks.start,
    repair: mocks.repair
  })
}));

describe("App error state", () => {
  beforeEach(() => {
    mocks.repair.mockReset();
    mocks.start.mockReset();
    mocks.state = {
      kind: "error",
      message: "something broke",
      logs: ["failed"]
    };
  });

  it("renders the error message", () => {
    render(<App />);
    expect(screen.getByText(/something broke/i)).toBeInTheDocument();
  });

  it("injects preview runtime error reporting into generated html", () => {
    const files = withPreviewErrorReporter(
      { "index.html": "<html><head></head><body></body></html>" },
      "r1"
    );

    expect(files["index.html"]).toContain(PREVIEW_ERROR_MESSAGE_TYPE);
    expect(files["index.html"]).toContain('"r1"');
    expect(files["index.html"]).toContain("</head>");
  });

  it("shows a repair button when the generated preview crashes", async () => {
    mocks.state = {
      kind: "ready",
      runId: "r1",
      logs: ["ready"],
      files: {
        "index.html": "<html><head></head><body><script src=\"index.js\"></script></body></html>",
        "index.js": "throw new Error('boom');"
      }
    };

    render(<App />);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: PREVIEW_ERROR_MESSAGE_TYPE,
          runId: "r1",
          message: "ReferenceError: count is not defined",
          stack: "ReferenceError: count is not defined\n    at index.js:1:1",
          filename: "index.js",
          lineno: 1,
          colno: 1
        }
      })
    );

    expect(await screen.findByText(/generated app crashed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /fix with llm/i }));

    await waitFor(() => {
      expect(mocks.repair).toHaveBeenCalledWith(
        "r1",
        expect.stringContaining("ReferenceError: count is not defined")
      );
    });
  });
});
