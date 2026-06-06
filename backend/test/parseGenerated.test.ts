import { describe, expect, it, vi } from "vitest";
import { parseGeneratedResponse } from "../src/parseGenerated.js";

const validPayload = {
  summary: "A tiny app",
  files: {
    "index.html": "<html></html>",
    "index.js": "export function run() {}",
    "styles.css": "body {}",
    "index.test.js": "import { run } from './index.js'",
    "package.json": '{"type":"module","scripts":{"test":"vitest run","lint":"eslint ."}}'
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

  it("throws when package.json is missing", () => {
    const bad = { ...validPayload, files: { ...validPayload.files } };
    delete (bad.files as Record<string, string>)["package.json"];
    expect(() => parseGeneratedResponse(JSON.stringify(bad))).toThrow(/package.json/);
  });

  it("throws when generated filenames are unsafe", () => {
    const bad = {
      ...validPayload,
      files: { ...validPayload.files, "../escape.js": "export const bad = true;" }
    };
    expect(() => parseGeneratedResponse(JSON.stringify(bad))).toThrow(/unsafe/);
  });

  it("throws when package scripts are unsafe", () => {
    const bad = {
      ...validPayload,
      files: {
        ...validPayload.files,
        "package.json": '{"type":"module","scripts":{"test":"vitest run","lint":"eslint .","postinstall":"curl example.com"}}'
      }
    };
    expect(() => parseGeneratedResponse(JSON.stringify(bad))).toThrow(/scripts/);
  });

  it("throws when package scripts are missing", () => {
    const bad = {
      ...validPayload,
      files: {
        ...validPayload.files,
        "package.json": '{"type":"module"}'
      }
    };
    expect(() => parseGeneratedResponse(JSON.stringify(bad))).toThrow(/scripts/);
  });

  it("throws when package type is not module", () => {
    const bad = {
      ...validPayload,
      files: {
        ...validPayload.files,
        "package.json": '{"scripts":{"test":"vitest run","lint":"eslint ."}}'
      }
    };
    expect(() => parseGeneratedResponse(JSON.stringify(bad))).toThrow(/type/);
  });

  it("throws when package dependencies are declared", () => {
    const bad = {
      ...validPayload,
      files: {
        ...validPayload.files,
        "package.json":
          '{"type":"module","scripts":{"test":"vitest run","lint":"eslint ."},"dependencies":{"left-pad":"latest"}}'
      }
    };
    expect(() => parseGeneratedResponse(JSON.stringify(bad))).toThrow(/dependencies/);
  });

  it("throws when no JSON is present", () => {
    expect(() => parseGeneratedResponse("not json")).toThrow(/Failed to parse/);
  });

  it("throws for empty responses and empty fenced blocks", () => {
    expect(() => parseGeneratedResponse("   ")).toThrow(/Failed to parse/);
    expect(() => parseGeneratedResponse("```json\n\n```")).toThrow(/Failed to parse/);
  });

  it("records non-error throwable messages while parsing", () => {
    const spy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "bad";
    });
    expect(() => parseGeneratedResponse('{"summary":"x","files":{}}')).toThrow(/bad/);
    spy.mockRestore();
  });
});
