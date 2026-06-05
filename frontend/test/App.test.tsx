import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/ui/App";

const start = vi.fn();

vi.mock("../src/hooks/useGeneration", () => ({
  useGeneration: () => ({
    state: { kind: "idle" },
    start
  })
}));

describe("App", () => {
  it("renders idea input and submit button", () => {
    render(<App />);
    expect(screen.getByLabelText(/what should we build/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument();
  });

  it("submits the current idea", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(start).toHaveBeenCalledWith("make pong");
  });
});
