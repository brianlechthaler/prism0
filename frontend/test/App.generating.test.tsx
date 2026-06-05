import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/App";

vi.mock("../src/hooks/useGeneration", () => ({
  useGeneration: () => ({
    state: { kind: "generating", runId: "abc", logs: ["working"] },
    start: vi.fn()
  })
}));

describe("App generating state", () => {
  it("disables submit and shows progress label", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /generating/i })).toBeDisabled();
    expect(screen.getByText("working")).toBeInTheDocument();
  });
});
