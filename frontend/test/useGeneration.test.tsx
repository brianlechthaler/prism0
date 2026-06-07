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

  it("starts repair runs for generated app runtime errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: "repair-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.repair("source-1", "ReferenceError: count is not defined");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/generate/source-1/fix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "ReferenceError: count is not defined" })
    });
    expect(eventSources.at(-1)?.url).toContain("/api/generate/repair-1/events");
    expect(result.current.state.kind).toBe("generating");
    if (result.current.state.kind === "generating") {
      expect(result.current.state.runId).toBe("repair-1");
    }
  });

  it("handles failed repair requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("project is not ready", { status: 409 }))
    );

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.repair("source-1", "Error: boom");
    });

    expect(result.current.state.kind).toBe("error");
    if (result.current.state.kind === "error") {
      expect(result.current.state.message).toBe("project is not ready");
    }
  });

  it("starts follow-up runs for generated app changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: "follow-up-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.followUp("source-1", "add a settings panel");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/generate/source-1/follow-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "add a settings panel" })
    });
    expect(eventSources.at(-1)?.url).toContain("/api/generate/follow-up-1/events");
    expect(result.current.state.kind).toBe("generating");
    if (result.current.state.kind === "generating") {
      expect(result.current.state.runId).toBe("follow-up-1");
    }
  });

  it("handles failed follow-up requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("project is not ready", { status: 409 }))
    );

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.followUp("source-1", "add settings");
    });

    expect(result.current.state.kind).toBe("error");
    if (result.current.state.kind === "error") {
      expect(result.current.state.message).toBe("project is not ready");
    }
  });

  it("closes an existing stream before starting a repair run", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ runId: "source-1" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ runId: "repair-1" }), {
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
    await act(async () => {
      await result.current.repair("source-1", "Error: boom");
    });

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(eventSources.at(-1)?.url).toContain("/api/generate/repair-1/events");
  });

  it("closes an existing stream before starting a follow-up run", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ runId: "source-1" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ runId: "follow-up-1" }), {
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
    await act(async () => {
      await result.current.followUp("source-1", "add settings");
    });

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(eventSources.at(-1)?.url).toContain("/api/generate/follow-up-1/events");
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
        data: JSON.stringify({
          type: "usage",
          metrics: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            contextWindowTokens: 100,
            contextUsedTokens: 15,
            contextUsedPercent: 15,
            outputTokensPerSecond: 2.5,
            buckets: [
              {
                kind: "generate",
                label: "LLM generate",
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15
              }
            ]
          }
        })
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
      expect(result.current.state.usage?.contextUsedPercent).toBe(15);
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
