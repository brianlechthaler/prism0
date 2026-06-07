import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  App,
  formatPreviewRuntimeError,
  PREVIEW_ERROR_MESSAGE_TYPE,
  withPreviewErrorReporter
} from "../src/ui/App";
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
  useModelOptions: () => ({
    defaultModel: "model-a",
    models: ["model-a", "model-b"],
    isLoading: false
  }),
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

  it("handles preview error formatting and injection fallbacks", () => {
    expect(
      formatPreviewRuntimeError({
        type: PREVIEW_ERROR_MESSAGE_TYPE,
        runId: "r1",
        message: "boom"
      })
    ).toBe("boom");
    expect(
      formatPreviewRuntimeError({
        type: PREVIEW_ERROR_MESSAGE_TYPE,
        runId: "r1",
        message: "boom",
        filename: "index.js",
        lineno: 2
      })
    ).toContain("Location: index.js:2");

    const bodyOnly = withPreviewErrorReporter({ "index.html": "<body></body>" }, "r1");
    expect(bodyOnly["index.html"]).toContain(PREVIEW_ERROR_MESSAGE_TYPE);
    expect(bodyOnly["index.html"]).toContain("</body>");

    const noInsertionPoint = withPreviewErrorReporter({ "index.html": "<main></main>" }, "r1");
    expect(noInsertionPoint["index.html"].startsWith("<script>")).toBe(true);

    const withoutHtml = { "index.js": "export const x = 1;" };
    expect(withPreviewErrorReporter(withoutHtml, "r1")).toBe(withoutHtml);
    expect(withPreviewErrorReporter(bodyOnly, "r1")).toBe(bodyOnly);
  });

  it("ignores malformed or stale preview error messages", async () => {
    mocks.state = {
      kind: "ready",
      runId: "r1",
      logs: ["ready"],
      files: {
        "index.html": "<html></html>",
        "index.js": "export const x = 1;"
      }
    };

    render(<App />);
    await act(async () => {});

    act(() => {
      for (const data of [
        null,
        { type: "other", runId: "r1", message: "boom" },
        { type: PREVIEW_ERROR_MESSAGE_TYPE, runId: 1, message: "boom" },
        { type: PREVIEW_ERROR_MESSAGE_TYPE, runId: "r1", message: 1 },
        { type: PREVIEW_ERROR_MESSAGE_TYPE, runId: "stale", message: "boom" }
      ]) {
        window.dispatchEvent(new MessageEvent("message", { data }));
      }
    });

    expect(screen.queryByText(/generated app crashed/i)).not.toBeInTheDocument();
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
    act(() => {
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
    });

    expect(await screen.findByText(/generated app crashed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /fix with llm/i }));

    await waitFor(() => {
      expect(mocks.repair).toHaveBeenCalledWith(
        "r1",
        expect.stringContaining("ReferenceError: count is not defined"),
        "model-a"
      );
    });
  });
});
