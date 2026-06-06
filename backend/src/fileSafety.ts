import path from "node:path";

const MAX_PROJECT_FILES = 50;
const MAX_PROJECT_FILE_PATH_BYTES = 260;
const MAX_PROJECT_FILE_BYTES = 200_000;
const MAX_PROJECT_TOTAL_BYTES = 1_000_000;

export function normalizeProjectFilePath(filename: string): string {
  if (filename.length === 0) {
    throw new Error("Generated file path cannot be empty");
  }
  if (filename.trim() !== filename) {
    throw new Error(`Generated file path has leading or trailing whitespace: ${filename}`);
  }
  if (filename.includes("\0")) {
    throw new Error("Generated file path cannot contain null bytes");
  }

  const normalizedSeparators = filename.replaceAll("\\", "/");
  if (normalizedSeparators.startsWith("/") || /^[A-Za-z]:/.test(normalizedSeparators)) {
    throw new Error(`Generated file path must be relative: ${filename}`);
  }

  const segments = normalizedSeparators.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Generated file path contains unsafe segments: ${filename}`);
  }
  if (segments.some((segment) => Buffer.byteLength(segment, "utf8") > 255)) {
    throw new Error(`Generated file path segment is too long: ${filename}`);
  }

  const normalized = path.posix.normalize(normalizedSeparators);
  if (Buffer.byteLength(normalized, "utf8") > MAX_PROJECT_FILE_PATH_BYTES) {
    throw new Error(`Generated file path is too long: ${filename}`);
  }

  return normalized;
}

export function normalizeProjectFiles(files: Record<string, string>): Record<string, string> {
  const entries = Object.entries(files);
  if (entries.length > MAX_PROJECT_FILES) {
    throw new Error(`Generated project includes too many files: ${entries.length}`);
  }

  let totalBytes = 0;
  const normalizedFiles: Record<string, string> = {};
  for (const [filename, content] of entries) {
    const normalized = normalizeProjectFilePath(filename);
    if (Object.hasOwn(normalizedFiles, normalized)) {
      throw new Error(`Generated project includes duplicate file path: ${normalized}`);
    }

    const fileBytes = Buffer.byteLength(content, "utf8");
    if (fileBytes > MAX_PROJECT_FILE_BYTES) {
      throw new Error(`Generated file is too large: ${normalized}`);
    }
    totalBytes += fileBytes;
    if (totalBytes > MAX_PROJECT_TOTAL_BYTES) {
      throw new Error("Generated project is too large");
    }

    normalizedFiles[normalized] = content;
  }

  return normalizedFiles;
}

export function resolveProjectFilePath(rootDir: string, filename: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, normalizeProjectFilePath(filename));
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Generated file path escapes validation workspace: ${filename}`);
  }
  return target;
}
