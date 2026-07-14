import { randomUUID } from "node:crypto";
import type { PrismDatabase } from "./db.js";
import { hashPassword, hashSessionToken, randomToken, verifyPassword } from "./crypto.js";
import type { EmailSender } from "./email.js";
import { buildVerificationEmail } from "./email.js";
import { validatePassword } from "./security.js";

export type PublicUser = {
  id: string;
  username: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  createdAt: number;
};

export type AuthServiceOptions = {
  db: PrismDatabase;
  sendEmail: EmailSender;
  appBaseUrl: string;
  sessionTtlMs: number;
  exposeVerificationToken: boolean;
  emailEnabled: boolean;
  now?: () => number;
};

export const EMAIL_DISABLED_MESSAGE = "Email is not enabled on this server";

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const REGISTRATION_FAILED_MESSAGE =
  "Registration failed. If you already have an account, try logging in or resending verification.";

export const EMAIL_UNAVAILABLE_MESSAGE = "Unable to update email address";

export class AuthService {
  private readonly db: PrismDatabase;
  private readonly sendEmail: EmailSender;
  private readonly appBaseUrl: string;
  private readonly sessionTtlMs: number;
  private readonly exposeVerificationToken: boolean;
  private readonly emailEnabled: boolean;
  private readonly now: () => number;

  constructor(options: AuthServiceOptions) {
    this.db = options.db;
    this.sendEmail = options.sendEmail;
    this.appBaseUrl = options.appBaseUrl;
    this.sessionTtlMs = options.sessionTtlMs;
    this.exposeVerificationToken = options.exposeVerificationToken;
    this.emailEnabled = options.emailEnabled;
    this.now = options.now ?? Date.now;
  }

  async register(input: {
    username: string;
    email?: string;
    password: string;
  }): Promise<{ user: PublicUser; verificationToken?: string }> {
    const username = input.username.trim();
    const email = this.emailEnabled ? (input.email?.trim().toLowerCase() ?? null) : null;
    if (!this.emailEnabled && input.email?.trim()) {
      throw new AuthError(EMAIL_DISABLED_MESSAGE);
    }
    const password = input.password;

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      throw new AuthError("Username must be 3-32 characters and use letters, numbers, or underscores");
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError("Invalid email address");
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      throw new AuthError(passwordError);
    }

    const existingUsername = this.db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .get(username);
    if (
      existingUsername ||
      (email && this.db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email))
    ) {
      throw new AuthError(REGISTRATION_FAILED_MESSAGE);
    }

    const id = randomUUID();
    const createdAt = this.now();
    const emailVerified = email ? 0 : 1;
    this.db
      .prepare(
        `INSERT INTO users (id, username, email, email_verified, password_hash, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(id, username, email, emailVerified, await hashPassword(password), createdAt, createdAt);

    if (!email) {
      return { user: this.getPublicUser(id)! };
    }

    const verificationToken = this.createVerificationToken(id);
    const emailContent = buildVerificationEmail(this.appBaseUrl, verificationToken);
    void this.sendEmail({ to: email, ...emailContent });

    return {
      user: this.getPublicUser(id)!,
      ...(this.exposeVerificationToken ? { verificationToken } : {})
    };
  }

  async login(username: string, password: string): Promise<{ user: PublicUser; sessionToken: string }> {
    const row = this.db
      .prepare(
        `SELECT id, username, email, email_verified, password_hash, display_name, created_at
         FROM users WHERE username = ? COLLATE NOCASE`
      )
      .get(username.trim()) as (UserRow & { password_hash: string }) | undefined;

    if (
      !row ||
      !(await verifyPassword(password, row.password_hash)) ||
      !this.isEmailVerificationSatisfied(row.email, row.email_verified)
    ) {
      throw new AuthError("Invalid username or password");
    }

    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
    const sessionToken = this.createSession(row.id);
    return { user: this.mapUser(row), sessionToken };
  }

  logout(sessionToken: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(hashSessionToken(sessionToken));
  }

  getUserBySession(sessionToken: string): PublicUser | undefined {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.email, u.email_verified, u.display_name, u.created_at, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`
      )
      .get(hashSessionToken(sessionToken)) as (UserRow & { expires_at: number }) | undefined;

    if (!row) return undefined;
    if (row.expires_at <= this.now()) {
      this.db.prepare("DELETE FROM sessions WHERE token = ?").run(hashSessionToken(sessionToken));
      return undefined;
    }

    return this.mapUser(row);
  }

  verifyEmail(token: string): PublicUser {
    this.requireEmailEnabled();
    const row = this.db
      .prepare(
        `SELECT evt.user_id, evt.expires_at
         FROM email_verification_tokens evt
         WHERE evt.token = ?`
      )
      .get(token) as { user_id: string; expires_at: number } | undefined;

    if (!row) throw new AuthError("Invalid verification token");
    if (row.expires_at <= this.now()) {
      this.db.prepare("DELETE FROM email_verification_tokens WHERE token = ?").run(token);
      throw new AuthError("Verification token has expired");
    }

    const updatedAt = this.now();
    this.db.prepare("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?").run(updatedAt, row.user_id);
    this.db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(row.user_id);
    return this.getPublicUser(row.user_id)!;
  }

  async resendVerification(username: string, password: string): Promise<{ verificationToken?: string }> {
    this.requireEmailEnabled();
    const row = this.db
      .prepare("SELECT id, email, email_verified, password_hash FROM users WHERE username = ? COLLATE NOCASE")
      .get(username.trim()) as
      | { id: string; email: string | null; email_verified: number; password_hash: string }
      | undefined;

    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new AuthError("Invalid username or password");
    }
    if (!row.email) throw new AuthError("No email address on this account");
    if (row.email_verified) throw new AuthError("Email is already verified");

    this.db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(row.id);
    const verificationToken = this.createVerificationToken(row.id);
    const emailContent = buildVerificationEmail(this.appBaseUrl, verificationToken);
    void this.sendEmail({ to: row.email, ...emailContent });
    return this.exposeVerificationToken ? { verificationToken } : {};
  }

  updateProfile(userId: string, displayName: string | null): PublicUser {
    const trimmed = displayName?.trim() ?? null;
    if (trimmed && trimmed.length > 64) {
      throw new AuthError("Display name must be 64 characters or fewer");
    }
    const updatedAt = this.now();
    this.db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(trimmed, updatedAt, userId);
    return this.getPublicUser(userId)!;
  }

  async changeEmail(userId: string, newEmail: string, password: string): Promise<PublicUser> {
    this.requireEmailEnabled();
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError("Invalid email address");
    }

    const user = this.getUserRecord(userId);
    if (!(await verifyPassword(password, user.password_hash))) {
      throw new AuthError("Invalid password");
    }

    const existing = this.db
      .prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?")
      .get(email, userId);
    if (existing) throw new AuthError(EMAIL_UNAVAILABLE_MESSAGE);

    const updatedAt = this.now();
    this.db
      .prepare("UPDATE users SET email = ?, email_verified = 0, updated_at = ? WHERE id = ?")
      .run(email, updatedAt, userId);

    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
    const verificationToken = this.createVerificationToken(userId);
    const emailContent = buildVerificationEmail(this.appBaseUrl, verificationToken);
    void this.sendEmail({ to: email, ...emailContent });

    return {
      ...this.getPublicUser(userId)!,
      ...(this.exposeVerificationToken ? {} : {})
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const passwordError = validatePassword(newPassword);
    if (passwordError) throw new AuthError(passwordError);
    const user = this.getUserRecord(userId);
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new AuthError("Invalid password");
    }
    const updatedAt = this.now();
    this.db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(await hashPassword(newPassword), updatedAt, userId);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = this.getUserRecord(userId);
    if (!(await verifyPassword(password, user.password_hash))) {
      throw new AuthError("Invalid password");
    }
    this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }

  private createVerificationToken(userId: string): string {
    const token = randomToken(24);
    const expiresAt = this.now() + EMAIL_TOKEN_TTL_MS;
    this.db
      .prepare("INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES (?, ?, ?)")
      .run(token, userId, expiresAt);
    return token;
  }

  private createSession(userId: string): string {
    const token = randomToken(32);
    const createdAt = this.now();
    const expiresAt = createdAt + this.sessionTtlMs;
    this.db
      .prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashSessionToken(token), userId, expiresAt, createdAt);
    return token;
  }

  private getPublicUser(userId: string): PublicUser | undefined {
    const row = this.db
      .prepare(
        `SELECT id, username, email, email_verified, display_name, created_at
         FROM users WHERE id = ?`
      )
      .get(userId) as UserRow | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  private getUserRecord(userId: string): { password_hash: string } {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
      | { password_hash: string }
      | undefined;
    if (!row) throw new AuthError("User not found");
    return row;
  }

  private requireEmailEnabled(): void {
    if (!this.emailEnabled) throw new AuthError(EMAIL_DISABLED_MESSAGE);
  }

  private isEmailVerificationSatisfied(email: string | null, emailVerified: number): boolean {
    return !this.emailEnabled || !email || Boolean(emailVerified);
  }

  private mapUser(row: UserRow): PublicUser {
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      emailVerified: Boolean(row.email_verified),
      displayName: row.display_name,
      createdAt: row.created_at
    };
  }
}

type UserRow = {
  id: string;
  username: string;
  email: string | null;
  email_verified: number;
  display_name: string | null;
  created_at: number;
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
