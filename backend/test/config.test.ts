import { describe, expect, it } from "vitest";
import { formatConfigIssues, loadConfig, parseModelList } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults base URL/model/port", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k" });
    expect(cfg.openaiApiKey).toBe("k");
    expect(cfg.openaiBaseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.openaiModel).toBe("gpt-4.1-mini");
    expect(cfg.openaiModels).toEqual(["gpt-4.1-mini"]);
    expect(cfg.modelPickerEnabled).toBe(false);
    expect(cfg.yoloModeEnabled).toBe(true);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(8787);
    expect(cfg.requestTimeoutMs).toBe(120_000);
    expect(cfg.contextWindowTokens).toBe(128_000);
    expect(cfg.contextCompressThreshold).toBe(0.9);
    expect(cfg.maxRuns).toBe(100);
    expect(cfg.maxActiveRuns).toBe(5);
    expect(cfg.generationRateLimitWindowMs).toBe(60_000);
    expect(cfg.generationRateLimitMax).toBe(10);
    expect(cfg.corsOrigin).toBeUndefined();
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.databasePath).toBe("./data/prism0.db");
    expect(cfg.appBaseUrl).toBe("http://localhost:8787");
    expect(cfg.sessionTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(cfg.authExposeVerificationToken).toBe(false);
    expect(cfg.authRateLimitWindowMs).toBe(60_000);
    expect(cfg.authRateLimitMax).toBe(20);
    expect(cfg.authLoginMaxFailures).toBe(5);
    expect(cfg.authLoginLockoutMs).toBe(15 * 60 * 1000);
  });

  it("accepts request timeout override from env", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", REQUEST_TIMEOUT_MS: "45000" });
    expect(cfg.requestTimeoutMs).toBe(45_000);
  });

  it("accepts context window override from env", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", OPENAI_CONTEXT_WINDOW: "200000" });
    expect(cfg.contextWindowTokens).toBe(200_000);
  });

  it("accepts context compress threshold override from env", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", OPENAI_CONTEXT_COMPRESS_THRESHOLD: "0.75" });
    expect(cfg.contextCompressThreshold).toBe(0.75);
  });

  it("accepts zero context compress threshold to disable compression", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", OPENAI_CONTEXT_COMPRESS_THRESHOLD: "0" });
    expect(cfg.contextCompressThreshold).toBe(0);
  });

  it("accepts max run retention override from env", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", MAX_RUNS: "25" });
    expect(cfg.maxRuns).toBe(25);
  });

  it("accepts generation abuse-control overrides from env", () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: "k",
      MAX_ACTIVE_RUNS: "2",
      GENERATION_RATE_LIMIT_WINDOW_MS: "30000",
      GENERATION_RATE_LIMIT_MAX: "4"
    });
    expect(cfg.maxActiveRuns).toBe(2);
    expect(cfg.generationRateLimitWindowMs).toBe(30_000);
    expect(cfg.generationRateLimitMax).toBe(4);
  });

  it("accepts overrides from env", () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: "https://example.com/v1",
      OPENAI_MODEL: "m",
      OPENAI_MODELS: "m, fallback-a, fallback-b",
      HOST: "127.0.0.1",
      PORT: "9999",
      CORS_ORIGIN: "https://app.example",
      TRUST_PROXY: "true"
    });
    expect(cfg.openaiBaseUrl).toBe("https://example.com/v1");
    expect(cfg.openaiModel).toBe("m");
    expect(cfg.openaiModels).toEqual(["m"]);
    expect(cfg.modelPickerEnabled).toBe(false);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(9999);
    expect(cfg.corsOrigin).toBe("https://app.example");
    expect(cfg.trustProxy).toBe(true);
  });

  it("uses configured model picker options only when enabled by CLI", () => {
    const cfg = loadConfig(
      {
        OPENAI_API_KEY: "k",
        OPENAI_MODEL: "m",
        OPENAI_MODELS: "m, fallback-a, fallback-b"
      },
      { modelPickerEnabled: true }
    );

    expect(cfg.openaiModels).toEqual(["m", "fallback-a", "fallback-b"]);
    expect(cfg.modelPickerEnabled).toBe(true);
  });

  it("enables YOLO mode by default", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k" });
    expect(cfg.yoloModeEnabled).toBe(true);
  });

  it("allows YOLO mode to be disabled via CLI", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k" }, { yoloModeEnabled: false });
    expect(cfg.yoloModeEnabled).toBe(false);
  });

  it("accepts false trust proxy override from env", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", TRUST_PROXY: "false" });
    expect(cfg.trustProxy).toBe(false);
  });

  it("accepts database, app URL, session, and auth token overrides from env", () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: "k",
      DATABASE_PATH: "/tmp/prism0-test.db",
      APP_BASE_URL: "https://app.example.com",
      SESSION_TTL_MS: "3600000",
      AUTH_EXPOSE_VERIFICATION_TOKEN: "true"
    });
    expect(cfg.databasePath).toBe("/tmp/prism0-test.db");
    expect(cfg.appBaseUrl).toBe("https://app.example.com");
    expect(cfg.sessionTtlMs).toBe(3_600_000);
    expect(cfg.authExposeVerificationToken).toBe(true);
  });

  it("ignores auth expose verification token in production", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const cfg = loadConfig({
        OPENAI_API_KEY: "k",
        AUTH_EXPOSE_VERIFICATION_TOKEN: "true"
      });
      expect(cfg.authExposeVerificationToken).toBe(false);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("accepts auth rate-limit overrides from env", () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: "k",
      AUTH_RATE_LIMIT_WINDOW_MS: "30000",
      AUTH_RATE_LIMIT_MAX: "3",
      AUTH_LOGIN_MAX_FAILURES: "2",
      AUTH_LOGIN_LOCKOUT_MS: "120000"
    });
    expect(cfg.authRateLimitWindowMs).toBe(30_000);
    expect(cfg.authRateLimitMax).toBe(3);
    expect(cfg.authLoginMaxFailures).toBe(2);
    expect(cfg.authLoginLockoutMs).toBe(120_000);
  });

  it("accepts false auth expose verification token override from env", () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: "k",
      AUTH_EXPOSE_VERIFICATION_TOKEN: "false"
    });
    expect(cfg.authExposeVerificationToken).toBe(false);
  });

  it("derives app base URL from configured port when APP_BASE_URL is omitted", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "k", PORT: "9001" });
    expect(cfg.appBaseUrl).toBe("http://localhost:9001");
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
    expect(cfg.openaiModels).toEqual(["cli-model"]);
    expect(cfg.modelPickerEnabled).toBe(false);
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

describe("parseModelList", () => {
  it("keeps the default model first and removes duplicates", () => {
    expect(parseModelList("primary", "fallback, primary, fallback, other")).toEqual([
      "primary",
      "fallback",
      "other"
    ]);
  });

  it("returns only the default model when no model list is provided", () => {
    expect(parseModelList("primary")).toEqual(["primary"]);
  });
});

describe("formatConfigIssues", () => {
  it("labels empty paths as env", () => {
    expect(formatConfigIssues([{ path: [], message: "root issue" }])).toBe("env: root issue");
  });

  it("formats Zod v4 property key paths", () => {
    expect(
      formatConfigIssues([{ path: ["nested", 0, Symbol.for("field")], message: "bad value" }])
    ).toBe("nested.0.Symbol(field): bad value");
  });
});
