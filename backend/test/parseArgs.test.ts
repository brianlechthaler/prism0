import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/parseArgs.js";

describe("parseCliArgs", () => {
  it("parses supported flags", () => {
    const args = parseCliArgs([
      "--api-key",
      "k",
      "--base-url",
      "https://example.com/v1",
      "--model",
      "m",
      "--port",
      "9000"
    ]);
    expect(args).toEqual({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      model: "m",
      port: 9000
    });
  });

  it("returns empty object when no flags are present", () => {
    expect(parseCliArgs([])).toEqual({});
  });
});
