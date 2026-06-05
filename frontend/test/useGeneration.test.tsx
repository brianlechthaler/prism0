import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGeneration } from "../src/hooks/useGeneration";

type MockEventSourceInstance = {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
};

const eventSources: MockEventSourceInstance[] = [];

class MockEventSource {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    eventSources.push(this);
  }
}

describe("useGeneration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    eventSources.length = 0;
  });

  it("handles failed generate requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }))
    );

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.start("make app");
    });

    expect(result.current.state.kind).toBe("error");
    if (result.current.state.kind === "error") {
      expect(result.current.state.message).toBe("bad request");
    }
  });

  it("tracks logs and completion events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ runId: "r1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());

    await act(async () => {
      await result.current.start("make app");
    });

    const source = eventSources.at(-1);
    expect(source?.url).toContain("/api/generate/r1/events");

    act(() => {
      source!.onmessage?.({
        data: JSON.stringify({ type: "log", line: "step" })
      } as MessageEvent);
      source!.onmessage?.({
        data: JSON.stringify({ type: "done", files: { "index.html": "<html/>" } })
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe("ready");
    });

    if (result.current.state.kind === "ready") {
      expect(result.current.state.logs).toContain("step");
      expect(result.current.state.files["index.html"]).toBe("<html/>");
    }
  });

  it("closes an existing stream before starting again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ runId: "r1" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
      )
    );
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.start("first");
      await result.current.start("second");
    });

    const closed = eventSources.filter((source) => source.close.mock.calls.length > 0);
    expect(closed.length).toBeGreaterThan(0);
  });

  it("handles SSE connection errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ runId: "r3" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.start("make app");
    });

    const source = eventSources.at(-1)!;
    act(() => {
      source.onerror?.();
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe("error");
    });
    if (result.current.state.kind === "error") {
      expect(result.current.state.message).toContain("Lost connection");
    }
  });

  it("handles server error events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ runId: "r2" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.start("make app");
    });

    const source = eventSources.at(-1)!;
    act(() => {
      source.onmessage?.({
        data: JSON.stringify({ type: "error", message: "generation failed" })
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe("error");
    });
    if (result.current.state.kind === "error") {
      expect(result.current.state.message).toBe("generation failed");
    }
  });
});
