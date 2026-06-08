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
      "--enable-model-picker",
      "--host",
      "127.0.0.1",
      "--port",
      "9000"
    ]);
    expect(args).toEqual({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      model: "m",
      modelPickerEnabled: true,
      host: "127.0.0.1",
      port: 9000
    });
  });

  it("returns empty object when no flags are present", () => {
    expect(parseCliArgs([])).toEqual({});
  });

  it("ignores flags that are missing values", () => {
    expect(parseCliArgs(["--api-key", "--base-url", "--model", "--host", "--port"])).toEqual({});
  });

  it("allows the model picker to be explicitly disabled", () => {
    expect(parseCliArgs(["--enable-model-picker", "--disable-model-picker"])).toEqual({
      modelPickerEnabled: false
    });
  });
});
