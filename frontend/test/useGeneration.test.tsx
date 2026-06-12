import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGeneration, useModelOptions } from "../src/hooks/useGeneration";

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

function expectApiPost(
  fetchMock: ReturnType<typeof vi.fn>,
  url: string,
  body: unknown
) {
  expect(fetchMock).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(body),
      credentials: "include"
    })
  );
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

  it("starts generation with a project id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: "r1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.start("make app", "model-b", { projectId: "proj-1" });
    });

    expectApiPost(fetchMock, "/api/generate", {
      idea: "make app",
      model: "model-b",
      projectId: "proj-1"
    });
  });

  it("starts generation with a selected model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: "r1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.start("make app", "model-b");
    });

    expectApiPost(fetchMock, "/api/generate", { idea: "make app", model: "model-b" });
  });

  it("starts generation with YOLO mode enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: "r1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.start("make app", undefined, { yolo: true });
    });

    expectApiPost(fetchMock, "/api/generate", { idea: "make app", yolo: true });
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
      await result.current.repair("source-1", "ReferenceError: count is not defined", "model-b");
    });

    expectApiPost(fetchMock, "/api/generate/source-1/fix", {
      error: "ReferenceError: count is not defined",
      model: "model-b"
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

  it("preserves context usage when starting a follow-up from a ready run", async () => {
    const fetchMock = vi
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
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());

    await act(async () => {
      await result.current.start("make app");
    });

    const sourceRun = eventSources.at(-1);
    act(() => {
      sourceRun!.onmessage?.({
        data: JSON.stringify({
          type: "usage",
          metrics: {
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            contextWindowTokens: 1000,
            contextUsedTokens: 140,
            contextUsedPercent: 14,
            outputTokensPerSecond: 20,
            buckets: [
              {
                kind: "generate",
                label: "LLM generate",
                inputTokens: 100,
                outputTokens: 40,
                totalTokens: 140
              }
            ]
          }
        })
      } as MessageEvent);
      sourceRun!.onmessage?.({
        data: JSON.stringify({ type: "done", files: { "index.html": "<html/>" } })
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe("ready");
    });

    await act(async () => {
      await result.current.followUp("source-1", "add a settings panel");
    });

    expect(result.current.state.kind).toBe("generating");
    if (result.current.state.kind === "generating") {
      expect(result.current.state.usage?.contextUsedPercent).toBe(14);
      expect(result.current.state.logs).toContain("Ready.");
      expect(result.current.state.logs).toContain("Requesting follow-up changes…");
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
      await result.current.followUp("source-1", "add a settings panel", "model-b");
    });

    expectApiPost(fetchMock, "/api/generate/source-1/follow-up", {
      prompt: "add a settings panel",
      model: "model-b"
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
        data: JSON.stringify({ type: "stream", channel: "thinking", chunk: "plan" })
      } as MessageEvent);
      source!.onmessage?.({
        data: JSON.stringify({ type: "stream", channel: "content", chunk: "{" })
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
      expect(result.current.state.streams.thinking).toBe("plan");
      expect(result.current.state.streams.content).toBe("{");
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
        data: JSON.stringify({
          type: "error",
          message: "generation failed",
          runId: "r2",
          files: { "index.js": "broken();" },
          repairable: true
        })
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe("error");
    });
    if (result.current.state.kind === "error") {
      expect(result.current.state.message).toBe("generation failed");
      expect(result.current.state.runId).toBe("r2");
      expect(result.current.state.files?.["index.js"]).toBe("broken();");
      expect(result.current.state.repairable).toBe(true);
    }
  });

  it("falls back to the active run id when server error events omit runId", async () => {
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
      expect(result.current.state.runId).toBe("r2");
    }
  });

  it("starts validation repair runs for failed validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: "validation-repair-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.repairValidation("source-1", "lint still failing", "model-b");
    });

    expectApiPost(fetchMock, "/api/generate/source-1/validation-fix", {
      error: "lint still failing",
      model: "model-b"
    });
    expect(eventSources.at(-1)?.url).toContain("/api/generate/validation-repair-1/events");
    expect(result.current.state.kind).toBe("generating");
    if (result.current.state.kind === "generating") {
      expect(result.current.state.runId).toBe("validation-repair-1");
    }
  });

  it("handles failed validation repair requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("project is not ready", { status: 409 }))
    );

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.repairValidation("source-1", "lint still failing");
    });

    expect(result.current.state.kind).toBe("error");
    if (result.current.state.kind === "error") {
      expect(result.current.state.message).toBe("project is not ready");
    }
  });
});

describe("useModelOptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads configured model options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ enabled: true, defaultModel: "model-a", models: ["model-a", "model-b"], yoloModeEnabled: true }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      )
    );

    const { result } = renderHook(() => useModelOptions());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current).toEqual({
      enabled: true,
      defaultModel: "model-a",
      models: ["model-a", "model-b"],
      yoloModeEnabled: true,
      isLoading: false
    });
  });

  it("reports model option load failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }))
    );

    const { result } = renderHook(() => useModelOptions());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.error).toBe("unavailable");
  });

  it("reports non-error model option failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network down"));

    const { result } = renderHook(() => useModelOptions());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.error).toBe("network down");
  });

  it("ignores model option success after unmount", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      )
    );

    const { unmount } = renderHook(() => useModelOptions());
    unmount();

    await act(async () => {
      resolveFetch(
        new Response(JSON.stringify({ enabled: true, defaultModel: "model-a", models: ["model-a"] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
  });

  it("ignores model option failures after unmount", async () => {
    let rejectFetch: (error: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFetch = reject;
          })
      )
    );

    const { unmount } = renderHook(() => useModelOptions());
    unmount();

    await act(async () => {
      rejectFetch(new Error("late failure"));
    });
  });
});
