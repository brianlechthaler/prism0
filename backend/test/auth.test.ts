import { describe, expect, it, vi } from "vitest";
import { AuthError, AuthService } from "../src/auth.js";
import { openDatabase } from "../src/db.js";

function createAuth(options?: {
  exposeVerificationToken?: boolean;
  now?: () => number;
  sendEmail?: () => Promise<void>;
}) {
  const db = openDatabase(":memory:");
  const sendEmail = options?.sendEmail ?? vi.fn(async () => {});
  const auth = new AuthService({
    db,
    sendEmail,
    appBaseUrl: "http://127.0.0.1:8787",
    sessionTtlMs: 60_000,
    exposeVerificationToken: options?.exposeVerificationToken ?? true,
    now: options?.now
  });
  return { auth, db, sendEmail };
}

describe("AuthService", () => {
  it("registers users and sends verification email", () => {
    const { auth, sendEmail } = createAuth();
    const result = auth.register({
      username: "tester",
      email: "Tester@Example.com",
      password: "password123"
    });

    expect(result.user.username).toBe("tester");
    expect(result.user.email).toBe("tester@example.com");
    expect(result.user.emailVerified).toBe(false);
    expect(result.verificationToken).toMatch(/^[0-9a-f]+$/);
    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("hides verification tokens when exposeVerificationToken is false", () => {
    const { auth } = createAuth({ exposeVerificationToken: false });
    const result = auth.register({
      username: "hidden",
      email: "hidden@example.com",
      password: "password123"
    });
    expect(result.verificationToken).toBeUndefined();
  });

  it("rejects invalid registration input", () => {
    const { auth } = createAuth();
    expect(() => auth.register({ username: "ab", email: "bad", password: "short" })).toThrow(AuthError);
    expect(() =>
      auth.register({ username: "valid_user", email: "not-an-email", password: "password123" })
    ).toThrow(/Invalid email/);
    expect(() =>
      auth.register({ username: "valid_user", email: "user@example.com", password: "short" })
    ).toThrow(/Password must be at least 8/);
  });

  it("rejects duplicate username and email with a generic message", () => {
    const { auth } = createAuth();
    auth.register({ username: "dup", email: "one@example.com", password: "password123" });
    expect(() =>
      auth.register({ username: "dup", email: "two@example.com", password: "password123" })
    ).toThrow(/Registration failed/);
    expect(() =>
      auth.register({ username: "other", email: "one@example.com", password: "password123" })
    ).toThrow(/Registration failed/);
  });

  it("logs in verified users and rejects invalid credentials", () => {
    const { auth } = createAuth();
    const { verificationToken } = auth.register({
      username: "login_user",
      email: "login@example.com",
      password: "password123"
    });
    expect(() => auth.login("login_user", "wrong-password")).toThrow(/Invalid username or password/);
    expect(() => auth.login("login_user", "password123")).toThrow(/Invalid username or password/);

    auth.verifyEmail(verificationToken!);
    const session = auth.login("login_user", "password123");
    expect(session.user.emailVerified).toBe(true);
    expect(session.sessionToken).toMatch(/^[0-9a-f]+$/);
  });

  it("replaces prior sessions when logging in again", () => {
    const { auth } = createAuth();
    const { verificationToken } = auth.register({
      username: "rotate_user",
      email: "rotate@example.com",
      password: "password123"
    });
    auth.verifyEmail(verificationToken!);
    const first = auth.login("rotate_user", "password123");
    const second = auth.login("rotate_user", "password123");
    expect(first.sessionToken).not.toBe(second.sessionToken);
    expect(auth.getUserBySession(first.sessionToken)).toBeUndefined();
    expect(auth.getUserBySession(second.sessionToken)?.username).toBe("rotate_user");
  });

  it("expires sessions and removes stale session tokens", () => {
    let now = 1_000_000;
    const { auth } = createAuth({ now: () => now });
    const { verificationToken } = auth.register({
      username: "session_user",
      email: "session@example.com",
      password: "password123"
    });
    auth.verifyEmail(verificationToken!);
    const { sessionToken } = auth.login("session_user", "password123");

    expect(auth.getUserBySession(sessionToken)).toBeDefined();
    now += 60_001;
    expect(auth.getUserBySession(sessionToken)).toBeUndefined();
  });

  it("logs out active sessions", () => {
    const { auth } = createAuth();
    const { verificationToken } = auth.register({
      username: "logout_user",
      email: "logout@example.com",
      password: "password123"
    });
    auth.verifyEmail(verificationToken!);
    const { sessionToken } = auth.login("logout_user", "password123");
    auth.logout(sessionToken);
    expect(auth.getUserBySession(sessionToken)).toBeUndefined();
  });

  it("verifies and expires email tokens", () => {
    let now = 1_000_000;
    const { auth } = createAuth({ now: () => now });
    const { verificationToken } = auth.register({
      username: "verify_user",
      email: "verify@example.com",
      password: "password123"
    });

    expect(() => auth.verifyEmail("missing-token")).toThrow(/Invalid verification token/);

    now += 24 * 60 * 60 * 1000 + 1;
    expect(() => auth.verifyEmail(verificationToken!)).toThrow(/expired/);

    const fresh = auth.register({
      username: "verify_user2",
      email: "verify2@example.com",
      password: "password123"
    });
    const verified = auth.verifyEmail(fresh.verificationToken!);
    expect(verified.emailVerified).toBe(true);
  });

  it("resends verification emails for unverified users", () => {
    const { auth, sendEmail } = createAuth();
    auth.register({ username: "resend", email: "resend@example.com", password: "password123" });
    expect(() => auth.resendVerification("resend", "wrong")).toThrow(/Invalid username or password/);

    const resent = auth.resendVerification("resend", "password123");
    expect(resent.verificationToken).toBeDefined();
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("rejects resend when email is already verified", () => {
    const { auth } = createAuth();
    const { verificationToken } = auth.register({
      username: "verified",
      email: "verified@example.com",
      password: "password123"
    });
    auth.verifyEmail(verificationToken!);
    expect(() => auth.resendVerification("verified", "password123")).toThrow(/already verified/);
  });

  it("hides resend verification tokens when exposeVerificationToken is false", () => {
    const { auth } = createAuth({ exposeVerificationToken: false });
    auth.register({ username: "hidden_resend", email: "hidden_resend@example.com", password: "password123" });
    expect(auth.resendVerification("hidden_resend", "password123")).toEqual({});
  });

  it("updates profile display names", () => {
    const { auth } = createAuth();
    const { verificationToken, user } = auth.register({
      username: "profile_user",
      email: "profile@example.com",
      password: "password123"
    });
    auth.verifyEmail(verificationToken!);

    const cleared = auth.updateProfile(user.id, null);
    expect(cleared.displayName).toBeNull();

    const updated = auth.updateProfile(user.id, "  Display Name  ");
    expect(updated.displayName).toBe("Display Name");
    expect(() => auth.updateProfile(user.id, "x".repeat(65))).toThrow(/64 characters/);
  });

  it("changes email and resets verification state", () => {
    const { auth, sendEmail } = createAuth({ exposeVerificationToken: true });
    const { verificationToken, user } = auth.register({
      username: "email_user",
      email: "email@example.com",
      password: "password123"
    });
    auth.verifyEmail(verificationToken!);

    expect(() => auth.changeEmail(user.id, "bad-email", "password123")).toThrow(/Invalid email/);
    expect(() => auth.changeEmail(user.id, "new@example.com", "wrong-password")).toThrow(/Invalid password/);

    auth.register({ username: "other_email", email: "taken@example.com", password: "password123" });
    expect(() => auth.changeEmail(user.id, "taken@example.com", "password123")).toThrow(/Unable to update email/);

    const updated = auth.changeEmail(user.id, "new@example.com", "password123");
    expect(updated.email).toBe("new@example.com");
    expect(updated.emailVerified).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it("changes passwords and clears sessions", () => {
    const { auth } = createAuth();
    const { verificationToken, user } = auth.register({
      username: "password_user",
      email: "password@example.com",
      password: "password123"
    });
    auth.verifyEmail(verificationToken!);
    const { sessionToken } = auth.login("password_user", "password123");

    expect(() => auth.changePassword(user.id, "wrong", "newpassword1")).toThrow(/Invalid password/);
    expect(() => auth.changePassword(user.id, "password123", "short")).toThrow(/at least 8/);

    auth.changePassword(user.id, "password123", "newpassword1");
    expect(auth.getUserBySession(sessionToken)).toBeUndefined();
    expect(auth.login("password_user", "newpassword1").user.id).toBe(user.id);
  });

  it("deletes accounts after password confirmation", () => {
    const { auth } = createAuth();
    const { verificationToken, user } = auth.register({
      username: "delete_user",
      email: "delete@example.com",
      password: "password123"
    });
    auth.verifyEmail(verificationToken!);
    expect(() => auth.deleteAccount(user.id, "wrong-password")).toThrow(/Invalid password/);
    auth.deleteAccount(user.id, "password123");
    expect(() => auth.changePassword(user.id, "password123", "newpassword1")).toThrow(/User not found/);
  });

  it("exposes AuthError name", () => {
    expect(new AuthError("boom").name).toBe("AuthError");
  });

  it("returns undefined for missing users from getPublicUser", () => {
    const { auth } = createAuth();
    expect((auth as unknown as { getPublicUser: (id: string) => unknown }).getPublicUser("missing")).toBeUndefined();
  });

  it("supports changeEmail when verification tokens are hidden", () => {
    const db = openDatabase(":memory:");
    const visible = new AuthService({
      db,
      sendEmail: async () => {},
      appBaseUrl: "http://127.0.0.1:8787",
      sessionTtlMs: 60_000,
      exposeVerificationToken: true
    });
    const { verificationToken, user } = visible.register({
      username: "hidden_change",
      email: "hidden_change@example.com",
      password: "password123"
    });
    visible.verifyEmail(verificationToken!);

    const hidden = new AuthService({
      db,
      sendEmail: async () => {},
      appBaseUrl: "http://127.0.0.1:8787",
      sessionTtlMs: 60_000,
      exposeVerificationToken: false
    });
    const updated = hidden.changeEmail(user.id, "changed@example.com", "password123");
    expect(updated.email).toBe("changed@example.com");
  });
});
