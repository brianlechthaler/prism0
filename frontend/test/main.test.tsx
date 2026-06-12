import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../src/api", () => ({
  apiFetch: apiFetchMock,
  readApiError: vi.fn(async (res: Response) => (await res.text()) || res.statusText || "Request failed")
}));

describe("main", () => {
  beforeEach(() => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), {
        status: 401,
        headers: { "content-type": "application/json" }
      })
    );
  });

  it("mounts the prism0 app", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import("../src/main");
    });
    await waitFor(() => {
      expect(document.getElementById("root")?.childElementCount).toBeGreaterThan(0);
    });
  });
});
