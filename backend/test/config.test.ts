import { describe, expect, it } from "vitest";
import { formatConfigIssues, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults base URL/model/port", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k" });
    expect(cfg.openaiApiKey).toBe("k");
    expect(cfg.openaiBaseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.openaiModel).toBe("gpt-4.1-mini");
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(8787);
    expect(cfg.requestTimeoutMs).toBe(120_000);
    expect(cfg.corsOrigin).toBeUndefined();
    expect(cfg.trustProxy).toBe(false);
  });

  it("accepts request timeout override from env", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", REQUEST_TIMEOUT_MS: "45000" });
    expect(cfg.requestTimeoutMs).toBe(45_000);
  });

  it("accepts overrides from env", () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: "https://example.com/v1",
      OPENAI_MODEL: "m",
      HOST: "127.0.0.1",
      PORT: "9999",
      CORS_ORIGIN: "https://app.example",
      TRUST_PROXY: "true"
    });
    expect(cfg.openaiBaseUrl).toBe("https://example.com/v1");
    expect(cfg.openaiModel).toBe("m");
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(9999);
    expect(cfg.corsOrigin).toBe("https://app.example");
    expect(cfg.trustProxy).toBe(true);
  });

  it("accepts false trust proxy override from env", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", TRUST_PROXY: "false" });
    expect(cfg.trustProxy).toBe(false);
  });

  it("prefers CLI args over env", () => {
    const cfg = loadConfig(
      {
        OPENAI_API_KEY: "env",
        OPENAI_BASE_URL: "https://env.example/v1",
        OPENAI_MODEL: "env-model",
        HOST: "env-host",
        PORT: "1111"
      },
      {
        apiKey: "cli",
        baseUrl: "https://cli.example/v1",
        model: "cli-model",
        host: "cli-host",
        port: 2222
      }
    );
    expect(cfg.openaiApiKey).toBe("cli");
    expect(cfg.openaiBaseUrl).toBe("https://cli.example/v1");
    expect(cfg.openaiModel).toBe("cli-model");
    expect(cfg.host).toBe("cli-host");
    expect(cfg.port).toBe(2222);
  });

  it("uses env port when cli port is omitted", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", PORT: "7777" }, { apiKey: "k" });
    expect(cfg.port).toBe(7777);
  });

  it("throws on missing api key", () => {
    expect(() => loadConfig({})).toThrow(/OPENAI_API_KEY/);
  });

  it("throws on invalid base URL", () => {
    expect(() => loadConfig({ OPENAI_API_KEY: "k", OPENAI_BASE_URL: "not-a-url" })).toThrow(
      /OPENAI_BASE_URL/
    );
  });
});

describe("formatConfigIssues", () => {
  it("labels empty paths as env", () => {
    expect(formatConfigIssues([{ path: [], message: "root issue" }])).toBe("env: root issue");
  });
});
