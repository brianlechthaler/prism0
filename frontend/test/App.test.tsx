import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { GeneratorApp, shouldSubmitIdeaOnKeyDown } from "../src/ui/GeneratorApp";
import { renderWithRouter } from "./helpers";
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

describe("GeneratorApp", () => {
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

  it("renders idea textarea and submit button", () => {
    renderWithRouter(<GeneratorApp />);
    expect(screen.getByLabelText(/what should we build/i).tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to prompt/i })).toHaveAttribute(
      "href",
      "#generator-prompt"
    );
  });

  it("shows enabled picker loading and error hints", () => {
    mocks.modelOptions = {
      enabled: true,
      defaultModel: "",
      models: [],
      yoloModeEnabled: false,
      isLoading: true
    };
    const view = renderWithRouter(<GeneratorApp />);
    expect(screen.getByText(/loading configured models/i)).toBeInTheDocument();

    mocks.modelOptions = {
      enabled: true,
      defaultModel: "",
      models: [],
      yoloModeEnabled: false,
      isLoading: false,
      error: "unavailable"
    };
    view.rerender(<MemoryRouter><GeneratorApp /></MemoryRouter>);
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

    renderWithRouter(<GeneratorApp />);
    expect(screen.queryByLabelText(/model/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(mocks.start).toHaveBeenCalledWith("make pong", undefined, undefined);
  });

  it("expands the idea field into a paragraph field on focus", () => {
    renderWithRouter(<GeneratorApp />);
    fireEvent.focus(screen.getByLabelText(/what should we build/i));
    const ideaField = screen.getByLabelText(/what should we build/i);
    expect(ideaField.tagName).toBe("TEXTAREA");
    expect(ideaField).toHaveAttribute("rows", "4");
    expect(ideaField).toHaveFocus();
  });

  it("submits the current idea", () => {
    renderWithRouter(<GeneratorApp />);
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(mocks.start).toHaveBeenCalledWith("make pong", "model-a", undefined);
  });

  it("submits the selected model", () => {
    renderWithRouter(<GeneratorApp />);
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
    const view = renderWithRouter(<GeneratorApp />);
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
    view.rerender(<MemoryRouter><GeneratorApp /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/model/i)).toHaveValue("model-a");
    });
  });

  it("resets a stale selected model to the first option when no default exists", async () => {
    const view = renderWithRouter(<GeneratorApp />);
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
    view.rerender(<MemoryRouter><GeneratorApp /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/model/i)).toHaveValue("model-c");
    });
  });

  it("clears a stale selected model when no options remain", async () => {
    const view = renderWithRouter(<GeneratorApp />);
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
    view.rerender(<MemoryRouter><GeneratorApp /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByLabelText(/model/i)).toBeDisabled();
    });
  });

  it("submits multiline ideas from the paragraph field", () => {
    renderWithRouter(<GeneratorApp />);
    fireEvent.focus(screen.getByLabelText(/what should we build/i));
    fireEvent.change(screen.getByLabelText(/what should we build/i), {
      target: { value: "make pong\nwith neon particles" }
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(mocks.start).toHaveBeenCalledWith("make pong\nwith neon particles", "model-a", undefined);
  });

  it("submits the prompt when shift+enter is pressed in the idea field", () => {
    renderWithRouter(<GeneratorApp />);
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.change(ideaField, { target: { value: "make pong" } });
    fireEvent.keyDown(ideaField, { key: "Enter", shiftKey: true });
    expect(mocks.start).toHaveBeenCalledWith("make pong", "model-a", undefined);
  });

  it("submits multiline prompts when shift+enter is pressed in the paragraph field", () => {
    renderWithRouter(<GeneratorApp />);
    fireEvent.focus(screen.getByLabelText(/what should we build/i));
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.change(ideaField, { target: { value: "make pong\nwith neon particles" } });
    fireEvent.keyDown(ideaField, { key: "Enter", code: "Enter", shiftKey: true });
    expect(mocks.start).toHaveBeenCalledWith("make pong\nwith neon particles", "model-a", undefined);
  });

  it("does not submit when shift+enter is pressed with an empty prompt", () => {
    renderWithRouter(<GeneratorApp />);
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.change(ideaField, { target: { value: "   " } });
    fireEvent.keyDown(ideaField, { key: "Enter", shiftKey: true });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not submit when shift+enter is pressed during ime composition", () => {
    expect(
      shouldSubmitIdeaOnKeyDown({
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        isComposing: true
      })
    ).toBe(false);
  });

  it("does not submit when a non-enter key is pressed", () => {
    expect(
      shouldSubmitIdeaOnKeyDown({
        key: "a",
        code: "KeyA",
        shiftKey: true,
        isComposing: false
      })
    ).toBe(false);
  });

  it("submits when only the enter key code is present", () => {
    expect(
      shouldSubmitIdeaOnKeyDown({
        key: "Unidentified",
        code: "Enter",
        shiftKey: true,
        isComposing: false
      })
    ).toBe(true);
  });

  it("does not submit when enter is pressed without shift in the paragraph field", () => {
    renderWithRouter(<GeneratorApp />);
    fireEvent.focus(screen.getByLabelText(/what should we build/i));
    const ideaField = screen.getByLabelText(/what should we build/i);
    fireEvent.change(ideaField, { target: { value: "make pong" } });
    fireEvent.keyDown(ideaField, { key: "Enter", code: "Enter", shiftKey: false });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("shows the single-model hint when only one backend model exists", () => {
    mocks.modelOptions = {
      enabled: true,
      defaultModel: "model-a",
      models: ["model-a"],
      yoloModeEnabled: false,
      isLoading: false
    };

    renderWithRouter(<GeneratorApp />);
    expect(screen.getByText(/only one backend model is configured/i)).toBeInTheDocument();
  });

  it("shows YOLO mode controls when enabled and submits the flag", () => {
    mocks.modelOptions = {
      enabled: false,
      defaultModel: "model-a",
      models: [],
      yoloModeEnabled: true,
      isLoading: false
    };

    renderWithRouter(<GeneratorApp />);
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
    renderWithRouter(<GeneratorApp />);
    expect(screen.queryByText(/yolo mode — skip lint\/tests/i)).not.toBeInTheDocument();
  });
});
