import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    start.mockClear();
  });

  it("renders idea input and submit button", () => {
    render(<App />);
    expect(screen.getByLabelText(/what should we build/i).tagName).toBe("INPUT");
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument();
  });

  it("expands the idea input into a paragraph field on click", () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText(/what should we build/i));
    const ideaField = screen.getByLabelText(/what should we build/i);
    expect(ideaField.tagName).toBe("TEXTAREA");
    expect(ideaField).toHaveAttribute("rows", "4");
    expect(ideaField).toHaveFocus();
  });

  it("submits the current idea", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(start).toHaveBeenCalledWith("make pong");
  });

  it("submits multiline ideas from the paragraph field", () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText(/what should we build/i));
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong\nwith neon particles" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(start).toHaveBeenCalledWith("make pong\nwith neon particles");
  });
});
