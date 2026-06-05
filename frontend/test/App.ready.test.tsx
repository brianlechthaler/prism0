import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/App";

vi.mock("@codesandbox/sandpack-react", () => ({
  Sandpack: () => <div data-testid="sandpack">sandpack</div>
}));

vi.mock("../src/hooks/useGeneration", () => ({
  useGeneration: () => ({
    state: {
      kind: "ready",
      runId: "abc",
      logs: ["done"],
      files: {
        "index.html": "<html></html>",
        "index.js": "export const x = 1;",
        "styles.css": "body {}",
        "index.test.js": "test",
        "package.json": "{}"
      }
    },
    start: vi.fn()
  })
}));

describe("App ready state", () => {
  it("shows download link and sandpack editor", () => {
    render(<App />);
    expect(screen.getByText(/download zip/i)).toBeInTheDocument();
    expect(screen.getByTestId("sandpack")).toBeInTheDocument();
  });
});
