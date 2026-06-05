import { describe, expect, it, vi } from "vitest";
import { parseGeneratedResponse } from "../src/parseGenerated.js";

const validPayload = {
  summary: "A tiny app",
  files: {
    "index.html": "<html></html>",
    "index.js": "export function run() {}",
    "styles.css": "body {}",
    "index.test.js": "import { run } from './index.js'",
    "package.json": "{}"
  }
};

describe("parseGeneratedResponse", () => {
  it("parses raw JSON", () => {
    const parsed = parseGeneratedResponse(JSON.stringify(validPayload));
    expect(parsed.summary).toBe("A tiny app");
    expect(parsed.files["index.html"]).toContain("<html>");
  });

  it("parses fenced JSON", () => {
    const parsed = parseGeneratedResponse(
      "Here you go:\n```json\n" + JSON.stringify(validPayload) + "\n```"
    );
    expect(parsed.files["index.js"]).toContain("run");
  });

  it("throws when required files are missing", () => {
    const bad = { ...validPayload, files: { ...validPayload.files } };
    delete (bad.files as Record<string, string>)["index.test.js"];
    expect(() => parseGeneratedResponse(JSON.stringify(bad))).toThrow(/index.test.js/);
  });

  it("throws when no JSON is present", () => {
    expect(() => parseGeneratedResponse("not json")).toThrow(/Failed to parse/);
  });

  it("records non-error throwable messages while parsing", () => {
    const spy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "bad";
    });
    expect(() => parseGeneratedResponse('{"summary":"x","files":{}}')).toThrow(/bad/);
    spy.mockRestore();
  });
});
