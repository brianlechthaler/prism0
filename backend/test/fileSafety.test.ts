import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeProjectFilePath,
  normalizeProjectFiles,
  resolveProjectFilePath
} from "../src/fileSafety.js";

describe("normalizeProjectFilePath", () => {
  it("normalizes windows separators in relative project paths", () => {
    expect(normalizeProjectFilePath("src\\app.js")).toBe("src/app.js");
  });

  it("rejects empty, padded, null, absolute, and traversal paths", () => {
    expect(() => normalizeProjectFilePath("")).toThrow(/empty/);
    expect(() => normalizeProjectFilePath(" index.js")).toThrow(/whitespace/);
    expect(() => normalizeProjectFilePath("index.js\0")).toThrow(/null/);
    expect(() => normalizeProjectFilePath("/tmp/index.js")).toThrow(/relative/);
    expect(() => normalizeProjectFilePath("C:\\tmp\\index.js")).toThrow(/relative/);
    expect(() => normalizeProjectFilePath("../index.js")).toThrow(/unsafe/);
    expect(() => normalizeProjectFilePath("src//index.js")).toThrow(/unsafe/);
    expect(() => normalizeProjectFilePath("./index.js")).toThrow(/unsafe/);
  });

  it("rejects overlong path segments and paths", () => {
    expect(() => normalizeProjectFilePath(`${"a".repeat(256)}.js`)).toThrow(/segment/);
    expect(() => normalizeProjectFilePath(`${"a/".repeat(131)}index.js`)).toThrow(/too long/);
  });
});

describe("normalizeProjectFiles", () => {
  it("normalizes filenames while preserving file contents", () => {
    expect(normalizeProjectFiles({ "src\\app.js": "x" })).toEqual({ "src/app.js": "x" });
  });

  it("rejects too many files, duplicate paths, and oversized content", () => {
    expect(() =>
      normalizeProjectFiles(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`${i}.js`, ""])))
    ).toThrow(/too many/);
    expect(() => normalizeProjectFiles({ "src/app.js": "x", "src\\app.js": "y" })).toThrow(
      /duplicate/
    );
    expect(() => normalizeProjectFiles({ "index.js": "x".repeat(200_001) })).toThrow(/too large/);
    expect(() =>
      normalizeProjectFiles(
        Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${i}.js`, "x".repeat(180_000)]))
      )
    ).toThrow(/project is too large/);
  });
});

describe("resolveProjectFilePath", () => {
  it("resolves safe paths inside the root directory", () => {
    expect(resolveProjectFilePath("/tmp/root", "src/app.js")).toBe(path.resolve("/tmp/root/src/app.js"));
  });
});
