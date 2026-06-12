import { randomUUID } from "node:crypto";
import type { PrismDatabase } from "./db.js";
import { hashPassword, randomToken, verifyPassword } from "./crypto.js";
import type { EmailSender } from "./email.js";
import { buildVerificationEmail } from "./email.js";

export type PublicUser = {
  id: string;
  username: string;
  email: string;
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
  now?: () => number;
};

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
  private readonly now: () => number;

  constructor(options: AuthServiceOptions) {
    this.db = options.db;
    this.sendEmail = options.sendEmail;
    this.appBaseUrl = options.appBaseUrl;
    this.sessionTtlMs = options.sessionTtlMs;
    this.exposeVerificationToken = options.exposeVerificationToken;
    this.now = options.now ?? Date.now;
  }

  register(input: {
    username: string;
    email: string;
    password: string;
  }): { user: PublicUser; verificationToken?: string } {
    const username = input.username.trim();
    const email = input.email.trim().toLowerCase();
    const password = input.password;

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      throw new AuthError("Username must be 3-32 characters and use letters, numbers, or underscores");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError("Invalid email address");
    }
    if (password.length < 8) {
      throw new AuthError("Password must be at least 8 characters");
    }

    const existingUsername = this.db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .get(username);
    if (existingUsername || this.db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
      throw new AuthError(REGISTRATION_FAILED_MESSAGE);
    }

    const id = randomUUID();
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO users (id, username, email, email_verified, password_hash, display_name, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, NULL, ?, ?)`
      )
      .run(id, username, email, hashPassword(password), createdAt, createdAt);

    const verificationToken = this.createVerificationToken(id);
    const emailContent = buildVerificationEmail(this.appBaseUrl, verificationToken);
    void this.sendEmail({ to: email, ...emailContent });

    return {
      user: this.getPublicUser(id)!,
      ...(this.exposeVerificationToken ? { verificationToken } : {})
    };
  }

  login(username: string, password: string): { user: PublicUser; sessionToken: string } {
    const row = this.db
      .prepare(
        `SELECT id, username, email, email_verified, password_hash, display_name, created_at
         FROM users WHERE username = ? COLLATE NOCASE`
      )
      .get(username.trim()) as
      | {
          id: string;
          username: string;
          email: string;
          email_verified: number;
          password_hash: string;
          display_name: string | null;
          created_at: number;
        }
      | undefined;

    if (!row || !verifyPassword(password, row.password_hash) || !row.email_verified) {
      throw new AuthError("Invalid username or password");
    }

    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
    const sessionToken = this.createSession(row.id);
    return { user: this.mapUser(row), sessionToken };
  }

  logout(sessionToken: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(sessionToken);
  }

  getUserBySession(sessionToken: string): PublicUser | undefined {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.email, u.email_verified, u.display_name, u.created_at, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`
      )
      .get(sessionToken) as
      | {
          id: string;
          username: string;
          email: string;
          email_verified: number;
          display_name: string | null;
          created_at: number;
          expires_at: number;
        }
      | undefined;

    if (!row) return undefined;
    if (row.expires_at <= this.now()) {
      this.db.prepare("DELETE FROM sessions WHERE token = ?").run(sessionToken);
      return undefined;
    }

    return this.mapUser(row);
  }

  verifyEmail(token: string): PublicUser {
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

  resendVerification(username: string, password: string): { verificationToken?: string } {
    const row = this.db
      .prepare("SELECT id, email, email_verified, password_hash FROM users WHERE username = ? COLLATE NOCASE")
      .get(username.trim()) as
      | { id: string; email: string; email_verified: number; password_hash: string }
      | undefined;

    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new AuthError("Invalid username or password");
    }
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

  changeEmail(userId: string, newEmail: string, password: string): PublicUser {
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError("Invalid email address");
    }

    const user = this.getUserRecord(userId);
    if (!verifyPassword(password, user.password_hash)) {
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

  changePassword(userId: string, currentPassword: string, newPassword: string): void {
    if (newPassword.length < 8) throw new AuthError("Password must be at least 8 characters");
    const user = this.getUserRecord(userId);
    if (!verifyPassword(currentPassword, user.password_hash)) {
      throw new AuthError("Invalid password");
    }
    const updatedAt = this.now();
    this.db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(hashPassword(newPassword), updatedAt, userId);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  deleteAccount(userId: string, password: string): void {
    const user = this.getUserRecord(userId);
    if (!verifyPassword(password, user.password_hash)) {
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
      .run(token, userId, expiresAt, createdAt);
    return token;
  }

  private getPublicUser(userId: string): PublicUser | undefined {
    const row = this.db
      .prepare(
        `SELECT id, username, email, email_verified, display_name, created_at
         FROM users WHERE id = ?`
      )
      .get(userId) as
      | {
          id: string;
          username: string;
          email: string;
          email_verified: number;
          display_name: string | null;
          created_at: number;
        }
      | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  private getUserRecord(userId: string): { password_hash: string } {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
      | { password_hash: string }
      | undefined;
    if (!row) throw new AuthError("User not found");
    return row;
  }

  private mapUser(row: {
    id: string;
    username: string;
    email: string;
    email_verified: number;
    display_name: string | null;
    created_at: number;
  }): PublicUser {
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

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
