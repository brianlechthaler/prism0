import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/ui/App";
import type { ModelOptionsState } from "../src/hooks/useGeneration";

const mocks = vi.hoisted(() => ({
  modelOptions: {
    enabled: true,
    defaultModel: "model-a",
    models: ["model-a", "model-b"],
    yoloModeEnabled: false,
    isLoading: false
  } as ModelOptionsState,
  start: vi.fn()
}));

vi.mock("../src/hooks/useGeneration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hooks/useGeneration")>();
  return {
    ...actual,
    useModelOptions: () => mocks.modelOptions,
    useGeneration: () => ({
      state: { kind: "idle" },
      start: mocks.start
    })
  };
});

describe("App", () => {
  beforeEach(() => {
    mocks.modelOptions = {
      enabled: true,
      defaultModel: "model-a",
      models: ["model-a", "model-b"],
      yoloModeEnabled: false,
      isLoading: false
    };
    mocks.start.mockClear();
  });

  it("renders idea input and submit button", () => {
    render(<App />);
    expect(screen.getByLabelText(/what should we build/i).tagName).toBe("INPUT");
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument();
  });

  it("shows enabled picker loading and error hints", () => {
    mocks.modelOptions = {
      enabled: true,
      defaultModel: "",
      models: [],
      yoloModeEnabled: false,
      isLoading: true
    };
    const view = render(<App />);
    expect(screen.getByText(/loading configured models/i)).toBeInTheDocument();

    mocks.modelOptions = {
      enabled: true,
      defaultModel: "",
      models: [],
      yoloModeEnabled: false,
      isLoading: false,
      error: "unavailable"
    };
    view.rerender(<App />);
    expect(screen.getByText(/could not load models: unavailable/i)).toBeInTheDocument();
  });

  it("hides the model picker and submits no model when disabled", () => {
    mocks.modelOptions = {
      enabled: false,
      defaultModel: "model-a",
      models: [],
      yoloModeEnabled: false,
      isLoading: false
    };

    render(<App />);
    expect(screen.queryByLabelText(/model/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(mocks.start).toHaveBeenCalledWith("make pong", undefined, undefined);
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
    expect(mocks.start).toHaveBeenCalledWith("make pong", "model-a", undefined);
  });

  it("submits the selected model", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong" }
    });
    fireEvent.change(screen.getByLabelText(/model/i), {
      target: { value: "model-b" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(mocks.start).toHaveBeenCalledWith("make pong", "model-b", undefined);
  });

  it("resets a stale selected model when options change", async () => {
    const view = render(<App />);
    fireEvent.change(screen.getByLabelText(/model/i), {
      target: { value: "model-b" }
    });
    expect(screen.getByLabelText(/model/i)).toHaveValue("model-b");

    mocks.modelOptions = {
      enabled: true,
      defaultModel: "model-a",
      models: ["model-a"],
      yoloModeEnabled: false,
      isLoading: false
    };
    view.rerender(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/model/i)).toHaveValue("model-a");
    });
  });

  it("resets a stale selected model to the first option when no default exists", async () => {
    const view = render(<App />);
    fireEvent.change(screen.getByLabelText(/model/i), {
      target: { value: "model-b" }
    });

    mocks.modelOptions = {
      enabled: true,
      defaultModel: "",
      models: ["model-c"],
      yoloModeEnabled: false,
      isLoading: false
    };
    view.rerender(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/model/i)).toHaveValue("model-c");
    });
  });

  it("clears a stale selected model when no options remain", async () => {
    const view = render(<App />);
    fireEvent.change(screen.getByLabelText(/model/i), {
      target: { value: "model-b" }
    });

    mocks.modelOptions = {
      enabled: true,
      defaultModel: "",
      models: [],
      yoloModeEnabled: false,
      isLoading: false
    };
    view.rerender(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/model/i)).toBeDisabled();
    });
  });

  it("submits multiline ideas from the paragraph field", () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText(/what should we build/i));
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong\nwith neon particles" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(mocks.start).toHaveBeenCalledWith("make pong\nwith neon particles", "model-a", undefined);
  });

  it("submits the prompt when shift+enter is pressed in the idea field", () => {
    render(<App />);
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.change(ideaField, { target: { value: "make pong" } });
    fireEvent.keyDown(ideaField, { key: "Enter", shiftKey: true });
    expect(mocks.start).toHaveBeenCalledWith("make pong", "model-a", undefined);
  });

  it("submits multiline prompts when shift+enter is pressed in the paragraph field", () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText(/what should we build/i));
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.change(ideaField, { target: { value: "make pong\nwith neon particles" } });
    fireEvent.keyDown(ideaField, { key: "Enter", shiftKey: true });
    expect(mocks.start).toHaveBeenCalledWith("make pong\nwith neon particles", "model-a", undefined);
  });

  it("does not submit when shift+enter is pressed with an empty prompt", () => {
    render(<App />);
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.change(ideaField, { target: { value: "   " } });
    fireEvent.keyDown(ideaField, { key: "Enter", shiftKey: true });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not submit when enter is pressed without shift in the paragraph field", () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText(/what should we build/i));
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.change(ideaField, { target: { value: "make pong" } });
    fireEvent.keyDown(ideaField, { key: "Enter", shiftKey: false });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("shows YOLO mode controls when enabled and submits the flag", () => {
    mocks.modelOptions = {
      enabled: false,
      defaultModel: "model-a",
      models: [],
      yoloModeEnabled: true,
      isLoading: false
    };

    render(<App />);
    expect(screen.getByText(/yolo mode — skip lint\/tests/i)).toBeInTheDocument();
    expect(screen.getByText(/may be unsafe, broken/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(mocks.start).toHaveBeenCalledWith("make pong", undefined, { yolo: true });
  });

  it("hides YOLO mode controls when disabled on the backend", () => {
    render(<App />);
    expect(screen.queryByText(/yolo mode — skip lint\/tests/i)).not.toBeInTheDocument();
  });
});
