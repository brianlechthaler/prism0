import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/App";

vi.mock("../src/hooks/useGeneration", () => ({
  useGeneration: () => ({
    state: {
      kind: "error",
      message: "something broke",
      logs: ["failed"]
    },
    start: vi.fn()
  })
}));

describe("App error state", () => {
  it("renders the error message", () => {
    render(<App />);
    expect(screen.getByText(/something broke/i)).toBeInTheDocument();
  });
});
