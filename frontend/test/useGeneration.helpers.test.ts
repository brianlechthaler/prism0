import { describe, expect, it } from "vitest";
import {
  appendLogLine,
  completeGeneration,
  failGeneration
} from "../src/hooks/useGeneration";

describe("appendLogLine", () => {
  it("ignores logs while idle", () => {
    const next = appendLogLine({ kind: "idle" }, "skip me");
    expect(next).toEqual({ kind: "idle" });
  });

  it("appends logs while generating", () => {
    const next = appendLogLine({ kind: "generating", runId: "r1", logs: ["a"] }, "b");
    expect(next).toEqual({ kind: "generating", runId: "r1", logs: ["a", "b"] });
  });
});

describe("completeGeneration", () => {
  it("handles idle state", () => {
    expect(completeGeneration({ kind: "idle" }, "r1", { "index.html": "<html/>" })).toEqual({
      kind: "ready",
      runId: "r1",
      logs: ["Ready."],
      files: { "index.html": "<html/>" }
    });
  });
});

describe("failGeneration", () => {
  it("handles idle state", () => {
    expect(failGeneration({ kind: "idle" }, "boom")).toEqual({
      kind: "error",
      message: "boom",
      logs: []
    });
  });
});
