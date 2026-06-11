import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { EditorPreview } from "../src/ui/EditorPreview";

const sandpackState = vi.hoisted(() => ({
  error: null as {
    title?: string;
    message: string;
    path?: string;
    line?: number;
    column?: number;
  } | null
}));

vi.mock("@codesandbox/sandpack-react", () => ({
  SandpackProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SandpackLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SandpackCodeEditor: () => <div>editor</div>,
  SandpackPreview: () => <div>preview</div>,
  useSandpack: () => ({ sandpack: { error: sandpackState.error } })
}));

describe("EditorPreview", () => {
  beforeEach(() => {
    sandpackState.error = null;
  });

  it("reports bundler errors to the parent", async () => {
    const onBundlerError = vi.fn();
    sandpackState.error = {
      title: "SyntaxError",
      message: "Unexpected token",
      path: "index.js",
      line: 3,
      column: 5
    };

    render(
      <EditorPreview
        files={{ "/index.js": "bad code" }}
        onBundlerError={onBundlerError}
      />
    );

    await waitFor(() => {
      expect(onBundlerError).toHaveBeenCalledWith(
        expect.stringContaining("SyntaxError")
      );
    });
    expect(onBundlerError).toHaveBeenCalledWith(expect.stringContaining("Location: index.js:3:5"));
  });

  it("reports bundler errors without location metadata", async () => {
    const onBundlerError = vi.fn();
    sandpackState.error = {
      message: "Unexpected token"
    };

    render(
      <EditorPreview
        files={{ "/index.js": "bad code" }}
        onBundlerError={onBundlerError}
      />
    );

    await waitFor(() => {
      expect(onBundlerError).toHaveBeenCalledWith("Unexpected token");
    });
  });

  it("reports bundler errors with path and line but no column", async () => {
    const onBundlerError = vi.fn();
    sandpackState.error = {
      message: "Unexpected token",
      path: "index.js",
      line: 3
    };

    render(
      <EditorPreview
        files={{ "/index.js": "bad code" }}
        onBundlerError={onBundlerError}
      />
    );

    await waitFor(() => {
      expect(onBundlerError).toHaveBeenCalledWith(
        expect.stringContaining("Location: index.js:3")
      );
    });
    expect(onBundlerError).not.toHaveBeenCalledWith(expect.stringContaining(":3:"));
  });

  it("ignores cleared sandpack errors", () => {
    const onBundlerError = vi.fn();
    sandpackState.error = null;

    render(
      <EditorPreview
        files={{ "/index.js": "ok" }}
        onBundlerError={onBundlerError}
      />
    );

    expect(onBundlerError).not.toHaveBeenCalled();
  });

  it("renders without an error watcher when no callback is provided", () => {
    const { container } = render(<EditorPreview files={{ "/index.js": "ok" }} />);
    expect(container.textContent).toContain("editor");
    expect(container.textContent).toContain("preview");
  });
});
