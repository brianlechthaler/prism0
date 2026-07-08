import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, readApiError } from "../src/api";

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends json requests with credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/test", {
      method: "POST",
      json: { hello: "world" },
      headers: { "x-test": "1" }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ hello: "world" }),
        credentials: "include",
        json: { hello: "world" }
      })
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-test")).toBe("1");
  });

  it("passes through non-json requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/plain", { method: "GET", body: "raw" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plain",
      expect.objectContaining({
        method: "GET",
        body: "raw",
        credentials: "include"
      })
    );
  });
});

describe("readApiError", () => {
  it("returns response text when present", async () => {
    const message = await readApiError(new Response("bad request", { status: 400 }));
    expect(message).toBe("bad request");
  });

  it("falls back to status text when body is empty", async () => {
    const message = await readApiError(new Response("", { status: 500, statusText: "Server Error" }));
    expect(message).toBe("Server Error");
  });

  it("falls back to a generic message when nothing else is available", async () => {
    const message = await readApiError(new Response("", { status: 500, statusText: "" }));
    expect(message).toBe("Request failed");
  });
});
