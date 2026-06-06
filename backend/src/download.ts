import AdmZip from "adm-zip";
import { normalizeProjectFiles } from "./fileSafety.js";

export function createProjectZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [filename, content] of Object.entries(normalizeProjectFiles(files))) {
    zip.addFile(filename, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer();
}
