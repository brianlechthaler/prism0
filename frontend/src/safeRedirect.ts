/** Allow only same-origin relative paths after login (blocks open redirects). */
export function safeRedirectPath(from: unknown, fallback = "/dashboard"): string {
  if (typeof from !== "string" || from.length === 0) return fallback;
  if (!from.startsWith("/") || from.startsWith("//")) return fallback;
  if (from.includes("\\") || from.includes("://")) return fallback;
  return from;
}
