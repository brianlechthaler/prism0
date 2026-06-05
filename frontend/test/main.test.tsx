import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("main", () => {
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
