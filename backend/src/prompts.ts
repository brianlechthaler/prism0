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
10. package.json is only for lint/test tooling metadata (no runtime npm deps required).
11. Code must pass ESLint (no-unused-vars): no unused variables, imports, or parameters.
12. Guard browser-only DOM setup in index.js so Vitest can import exported logic without a loaded page.

Quality bar:
- Thoughtful UX copy and states (loading/empty/error when relevant)
- Defensive coding for user input
- Comments only where logic is non-obvious
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
5. Do not introduce unused variables, imports, or parameters.
6. Guard browser-only DOM setup in index.js so Vitest can import exported logic without a loaded page.
`;
}

export function buildJsonFixPrompt(
  idea: string,
  parseError: string,
  invalidResponse: string
): string {
  return `You are prism0, an expert frontend engineer. Your previous response could not be parsed as JSON.

Original app idea:
"${idea}"

JSON parse error:
"""
${parseError}
"""

Your invalid response:
"""
${invalidResponse}
"""

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
`;
}
