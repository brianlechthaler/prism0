import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { createProjectZip } from "../src/download.js";

describe("createProjectZip", () => {
  it("creates a zip containing project files", () => {
    const zipBuffer = createProjectZip({
      "index.html": "<html></html>",
      "index.js": "console.log('hi')"
    });

    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries().map((e) => e.entryName);
    expect(entries).toContain("index.html");
    expect(entries).toContain("index.js");
  });
});
