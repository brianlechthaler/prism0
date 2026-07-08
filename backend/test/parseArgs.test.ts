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
      "--enable-yolo-mode",
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
      yoloModeEnabled: true,
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

  it("allows YOLO mode to be explicitly disabled", () => {
    expect(parseCliArgs(["--enable-yolo-mode", "--disable-yolo-mode"])).toEqual({
      yoloModeEnabled: false
    });
  });

  it("allows YOLO mode to be disabled without a prior enable flag", () => {
    expect(parseCliArgs(["--disable-yolo-mode"])).toEqual({
      yoloModeEnabled: false
    });
  });

  it("enables login when requested", () => {
    expect(parseCliArgs(["--enable-login"])).toEqual({
      authEnabled: true
    });
  });

  it("allows login to be explicitly disabled", () => {
    expect(parseCliArgs(["--enable-login", "--disable-login"])).toEqual({
      authEnabled: false
    });
  });
});
