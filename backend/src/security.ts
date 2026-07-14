const MIN_PASSWORD_LENGTH = 12;

const COMMON_PASSWORDS = new Set([
  "123456789012",
  "qwertyuiop12",
  "adminadmin12"
]);

export function validatePassword(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 200) {
    return "Password must be 200 characters or fewer";
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "Password is too common; choose a stronger password";
  }
  return undefined;
}

export function sanitizeClientError(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key[=:]\s*\S+/gi, "api_key=[redacted]")
    .slice(0, 2000);
}

export function redactUrlForLogs(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "[invalid-url]";
  }
}

export function spaContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ");
}

export function hostedContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https: http:",
    "object-src 'none'",
    "base-uri 'self'"
  ].join("; ");
}
