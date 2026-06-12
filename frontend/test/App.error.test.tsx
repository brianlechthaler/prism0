import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  formatPreviewRuntimeError,
  GeneratorApp,
  PREVIEW_ERROR_MESSAGE_TYPE,
  withPreviewErrorReporter
} from "../src/ui/GeneratorApp";
import type { GenerationState } from "../src/hooks/useGeneration";
import { renderWithRouter } from "./helpers";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  repairValidation: vi.fn(),
  start: vi.fn(),
  state: {
    kind: "error",
    message: "something broke",
    logs: ["failed"],
    streams: { thinking: "", content: "" }
  } as GenerationState
}));

vi.mock("../src/ui/EditorPreview", () => ({
  EditorPreview: () => null
}));

vi.mock("../src/hooks/useGeneration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hooks/useGeneration")>();
  return {
    ...actual,
    useModelOptions: () => ({
      enabled: true,
      defaultModel: "model-a",
      models: ["model-a", "model-b"],
      yoloModeEnabled: false,
      isLoading: false
    }),
    useGeneration: () => ({
      state: mocks.state,
      start: mocks.start,
      repair: mocks.repair,
      repairValidation: mocks.repairValidation,
      followUp: vi.fn()
    })
  };
});

describe("GeneratorApp error state", () => {
  beforeEach(() => {
    mocks.repair.mockReset();
    mocks.repairValidation.mockReset();
    mocks.start.mockReset();
    mocks.state = {
      kind: "error",
      message: "something broke",
      logs: ["failed"],
      streams: { thinking: "", content: "" }
    };
  });

  it("renders the error message", () => {
    renderWithRouter(<GeneratorApp />);
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
        stack: "Error: boom\n    at test.js:1:1",
        filename: "index.js",
        lineno: 2
      })
    ).toContain("Error: boom\n    at test.js:1:1");
    expect(
      formatPreviewRuntimeError({
        type: PREVIEW_ERROR_MESSAGE_TYPE,
        runId: "r1",
        message: "boom",
        filename: "index.js",
        lineno: 2,
        colno: 5
      })
    ).toContain("Location: index.js:2:5");

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
      streams: { thinking: "", content: "" },
      files: {
        "index.html": "<html></html>",
        "index.js": "export const x = 1;"
      }
    };

    renderWithRouter(<GeneratorApp />);
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

    expect(screen.queryByText(/generated app has an error/i)).not.toBeInTheDocument();
  });

  it("shows a repair button when the generated preview crashes", async () => {
    mocks.state = {
      kind: "ready",
      runId: "r1",
      logs: ["ready"],
      streams: { thinking: "", content: "" },
      files: {
        "index.html": "<html><head></head><body><script src=\"index.js\"></script></body></html>",
        "index.js": "throw new Error('boom');"
      }
    };

    renderWithRouter(<GeneratorApp />);
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

    expect(await screen.findByText(/generated app has an error/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /fix with llm/i }));

    await waitFor(() => {
      expect(mocks.repair).toHaveBeenCalledWith(
        "r1",
        expect.stringContaining("ReferenceError: count is not defined"),
        "model-a"
      );
    });
  });

  it("shows a validation repair button when generation fails with repairable files", async () => {
    mocks.state = {
      kind: "error",
      runId: "failed-1",
      message: "lint still failing",
      repairable: true,
      logs: ["[2026-01-01T00:00:00.000Z] Validation error: eslint failed on index.js"],
      streams: { thinking: "", content: "" },
      files: {
        "index.html": "<html><head></head><body><script src=\"index.js\"></script></body></html>",
        "index.js": "export const broken = true;"
      }
    };

    renderWithRouter(<GeneratorApp />);
    expect(await screen.findByText(/generated code failed validation/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /fix with llm/i }));

    await waitFor(() => {
      expect(mocks.repairValidation).toHaveBeenCalledWith(
        "failed-1",
        "eslint failed on index.js",
        "model-a"
      );
    });
  });

  it("does not render the editor when a repairable error is missing a run id", () => {
    mocks.state = {
      kind: "error",
      message: "lint still failing",
      repairable: true,
      logs: ["failed"],
      streams: { thinking: "", content: "" },
      files: { "index.js": "broken();" }
    };

    renderWithRouter(<GeneratorApp />);
    expect(screen.getByText(/when generation finishes/i)).toBeInTheDocument();
  });
});
