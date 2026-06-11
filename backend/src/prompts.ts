import type { GeneratedProject } from "./types.js";

export const MAX_VALIDATION_ATTEMPTS = 5;
export const MAX_PARSE_ATTEMPTS = 3;

export function buildGenerationPrompt(idea: string): string {
  return `You are prism0, an expert frontend engineer who builds delightful browser apps with test-driven development.

The user wants this app idea implemented exactly:
"${idea}"

Return ONLY valid JSON (no markdown fences, no commentary) with this shape:
{
  "summary": "one sentence describing what you built",
  "files": {
    "index.html": "...",
    "index.js": "...",
    "styles.css": "...",
    "index.test.js": "...",
    "package.json": "{\\"type\\":\\"module\\",\\"scripts\\":{\\"test\\":\\"vitest run\\",\\"lint\\":\\"eslint .\\"}}"
  }
}

JSON formatting rules (critical — invalid JSON will be rejected):
1. Output must be a single JSON object starting with "{" and ending with "}".
2. Use double quotes for all keys and string values; never use single quotes.
3. Escape special characters inside strings: \\" for quotes, \\n for newlines, \\\\ for backslashes.
4. No trailing commas, comments, or JavaScript syntax (no undefined, no unquoted keys).
5. Do not wrap the JSON in markdown code fences or add any text before or after it.

Hard requirements:
1. Vanilla HTML/CSS/JS that runs directly in the browser (no bundler required).
2. Mobile-first responsive layout; works on desktop and mobile.
3. Accessible semantics (labels, aria where needed, keyboard support).
4. Clean, modern, minimalist UI with whimsical micro-interactions/animations.
5. Test-driven development: include meaningful Vitest tests in index.test.js.
6. index.html must load styles.css and index.js.
7. index.js must export the core logic for tests (e.g. export functions/classes used by tests).
8. Keep files reasonably small but complete and runnable.
9. Do not include external CDN dependencies except none required; prefer zero dependencies in runtime.
10. File paths must be relative project paths only; never include absolute paths, backslashes, ".", "..", or empty path segments.
11. package.json must contain only "type": "module" and scripts exactly {"test":"vitest run","lint":"eslint ."}; no dependencies or extra scripts.
12. Code must pass ESLint (no-unused-vars): no unused variables, imports, or parameters.
13. Guard browser-only DOM setup in index.js so Vitest can import exported logic without a loaded page.

Quality bar:
- Thoughtful UX copy and states (loading/empty/error when relevant)
- Defensive coding for user input
- Comments only where logic is non-obvious
`;
}

export function buildFollowUpPrompt(
  idea: string,
  project: GeneratedProject,
  followUpPrompt: string
): string {
  const filesJson = JSON.stringify(project.files, null, 2);

  return `You are prism0, an expert frontend engineer iterating on an existing generated browser app with test-driven development.

Original app idea:
"${idea}"

Current project summary:
"${project.summary}"

The user wants this follow-up change implemented:
"""
${followUpPrompt}
"""

Current project files:
${filesJson}

Update the existing app to satisfy the follow-up request. Return the complete updated project, not a diff.

Return ONLY valid JSON (no markdown fences, no commentary) with this shape:
{
  "summary": "one sentence describing what you built",
  "files": {
    "index.html": "...",
    "index.js": "...",
    "styles.css": "...",
    "index.test.js": "...",
    "package.json": "{\\"type\\":\\"module\\",\\"scripts\\":{\\"test\\":\\"vitest run\\",\\"lint\\":\\"eslint .\\"}}"
  }
}

JSON formatting rules (critical — invalid JSON will be rejected):
1. Output must be a single JSON object starting with "{" and ending with "}".
2. Use double quotes for all keys and string values; never use single quotes.
3. Escape special characters inside strings: \\" for quotes, \\n for newlines, \\\\ for backslashes.
4. No trailing commas, comments, or JavaScript syntax (no undefined, no unquoted keys).
5. Do not wrap the JSON in markdown code fences or add any text before or after it.

Requirements:
1. Preserve existing working behavior unless the follow-up explicitly changes it.
2. Implement the follow-up request completely across HTML, CSS, JS, and tests as needed.
3. Add or update meaningful Vitest tests in index.test.js for changed behavior.
4. Keep vanilla HTML/CSS/JS with exported core logic in index.js for tests.
5. Keep file paths relative and package.json scripts exactly {"test":"vitest run","lint":"eslint ."} with no dependencies or extra scripts.
6. Do not introduce unused variables, imports, or parameters.
7. Guard browser-only DOM setup in index.js so Vitest can import exported logic without a loaded page.
`;
}

export function buildFixPrompt(
  idea: string,
  project: GeneratedProject,
  validationError: string
): string {
  const filesJson = JSON.stringify(project.files, null, 2);

  return `You are prism0, an expert frontend engineer fixing a generated browser app so it passes lint and tests.

Original app idea:
"${idea}"

Current project summary:
"${project.summary}"

Validation failed with this output:
"""
${validationError}
"""

Current project files:
${filesJson}

Fix every lint and test failure above. Return ONLY valid JSON (no markdown fences, no commentary) with this shape:
{
  "summary": "one sentence describing what you built",
  "files": {
    "index.html": "...",
    "index.js": "...",
    "styles.css": "...",
    "index.test.js": "...",
    "package.json": "{\\"type\\":\\"module\\",\\"scripts\\":{\\"test\\":\\"vitest run\\",\\"lint\\":\\"eslint .\\"}}"
  }
}

JSON formatting rules (critical — invalid JSON will be rejected):
1. Output must be a single JSON object starting with "{" and ending with "}".
2. Use double quotes for all keys and string values; never use single quotes.
3. Escape special characters inside strings: \\" for quotes, \\n for newlines, \\\\ for backslashes.
4. No trailing commas, comments, or JavaScript syntax (no undefined, no unquoted keys).
5. Do not wrap the JSON in markdown code fences or add any text before or after it.

Requirements:
1. Preserve the original app idea and working behavior unless a test requires a change.
2. Fix all reported ESLint errors (especially no-unused-vars).
3. Fix all failing Vitest assertions.
4. Keep vanilla HTML/CSS/JS with exported core logic in index.js for tests.
5. Keep file paths relative and package.json scripts exactly {"test":"vitest run","lint":"eslint ."} with no dependencies or extra scripts.
6. Do not introduce unused variables, imports, or parameters.
7. Guard browser-only DOM setup in index.js so Vitest can import exported logic without a loaded page.
`;
}

export function buildRuntimeFixPrompt(
  idea: string,
  project: GeneratedProject,
  runtimeError: string
): string {
  const filesJson = JSON.stringify(project.files, null, 2);

  return `You are prism0, an expert frontend engineer fixing a generated browser app that crashes at runtime.

Original app idea:
"${idea}"

Current project summary:
"${project.summary}"

The browser preview threw this critical runtime error:
"""
${runtimeError}
"""

Current project files:
${filesJson}

Fix the runtime crash above and any directly related defects. Return ONLY valid JSON (no markdown fences, no commentary) with this shape:
{
  "summary": "one sentence describing what you built",
  "files": {
    "index.html": "...",
    "index.js": "...",
    "styles.css": "...",
    "index.test.js": "...",
    "package.json": "{\\"type\\":\\"module\\",\\"scripts\\":{\\"test\\":\\"vitest run\\",\\"lint\\":\\"eslint .\\"}}"
  }
}

JSON formatting rules (critical — invalid JSON will be rejected):
1. Output must be a single JSON object starting with "{" and ending with "}".
2. Use double quotes for all keys and string values; never use single quotes.
3. Escape special characters inside strings: \\" for quotes, \\n for newlines, \\\\ for backslashes.
4. No trailing commas, comments, or JavaScript syntax (no undefined, no unquoted keys).
5. Do not wrap the JSON in markdown code fences or add any text before or after it.

Requirements:
1. Preserve the original app idea and working behavior unless it caused the runtime crash.
2. Fix the reported runtime error and add or update tests that would catch the bug where practical.
3. Keep vanilla HTML/CSS/JS with exported core logic in index.js for tests.
4. Keep file paths relative and package.json scripts exactly {"test":"vitest run","lint":"eslint ."} with no dependencies or extra scripts.
5. Do not introduce unused variables, imports, or parameters.
6. Guard browser-only DOM setup in index.js so Vitest can import exported logic without a loaded page.
`;
}

export function buildJsonFixPrompt(
  idea: string,
  parseError: string,
  invalidResponse: string,
  contextSummary?: string
): string {
  const compressedContext = contextSummary
    ? `Compressed run context from earlier steps:
"""
${contextSummary}
"""

`
    : "";

  const responseSection = contextSummary
    ? `Your invalid response (truncated):
"""
${truncateForPrompt(invalidResponse, 4000)}
"""`
    : `Your invalid response:
"""
${invalidResponse}
"""`;

  return `You are prism0, an expert frontend engineer. Your previous response could not be parsed as JSON.

${compressedContext}Original app idea:
"${idea}"

JSON parse error:
"""
${parseError}
"""

${responseSection}

Fix the JSON syntax so it is valid and parseable. Preserve the intended app code and file contents from your previous response.

Return ONLY valid JSON (no markdown fences, no commentary) with this shape:
{
  "summary": "one sentence describing what you built",
  "files": {
    "index.html": "...",
    "index.js": "...",
    "styles.css": "...",
    "index.test.js": "...",
    "package.json": "{\\"type\\":\\"module\\",\\"scripts\\":{\\"test\\":\\"vitest run\\",\\"lint\\":\\"eslint .\\"}}"
  }
}

JSON formatting rules (critical):
1. Output must be a single JSON object starting with "{" and ending with "}".
2. Use double quotes for all keys and string values; never use single quotes.
3. Escape special characters inside strings: \\" for quotes, \\n for newlines, \\\\ for backslashes.
4. No trailing commas, comments, or JavaScript syntax (no undefined, no unquoted keys).
5. Do not wrap the JSON in markdown code fences or add any text before or after it.
6. Include all required files: index.html, index.js, styles.css, index.test.js, package.json.
7. Keep file paths relative and package.json scripts exactly {"test":"vitest run","lint":"eslint ."} with no dependencies or extra scripts.
`;
}

export function buildContextCompressionPrompt(options: {
  idea: string;
  project?: GeneratedProject;
  recentLogs: string[];
  priorSummary?: string;
  contextUsedPercent: number;
}): string {
  const { idea, project, recentLogs, priorSummary, contextUsedPercent } = options;
  const fileListing = project
    ? Object.entries(project.files)
        .map(([name, content]) => `- ${name} (${content.length} chars)`)
        .join("\n")
    : "(no project files yet)";
  const logTail = recentLogs.slice(-40).join("\n");
  const priorSection = priorSummary
    ? `Prior compressed context:
"""
${priorSummary}
"""

`
    : "";

  return `You are prism0, an expert frontend engineer. A generation run is nearing its context window limit (${contextUsedPercent.toFixed(1)}% used).

Summarize the run context below so generation can continue with a fresh context window. Preserve:
- The original app idea and requirements
- Current project state and key implementation decisions
- Errors encountered and fixes attempted
- Anything still pending or in progress

${priorSection}Original app idea:
"${idea}"

Current project summary:
"${project?.summary ?? "(not generated yet)"}"

Current project files:
${fileListing}

Recent run logs:
"""
${logTail || "(none)"}
"""

Return ONLY valid JSON (no markdown fences, no commentary) with this shape:
{
  "summary": "concise but complete summary of the run context"
}

JSON formatting rules (critical):
1. Output must be a single JSON object starting with "{" and ending with "}".
2. Use double quotes for all keys and string values.
3. Do not wrap the JSON in markdown code fences or add any text before or after it.
`;
}

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]`;
}
