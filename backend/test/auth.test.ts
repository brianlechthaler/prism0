import { describe, expect, it, vi } from "vitest";
import { AuthError, AuthService } from "../src/auth.js";
import { openDatabase } from "../src/db.js";

function createAuth(options?: {
  exposeVerificationToken?: boolean;
  emailEnabled?: boolean;
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
    emailEnabled: options?.emailEnabled ?? true,
    now: options?.now
  });
  return { auth, db, sendEmail };
}

describe("AuthService", () => {
  it("registers users without email when email is disabled", async () => {
    const { auth, sendEmail } = createAuth({ emailEnabled: false });
    const result = await auth.register({
      username: "disabled_email",
      password: "securepass12"
    });

    expect(result.user.email).toBeNull();
    expect(result.user.emailVerified).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await auth.login("disabled_email", "securepass12")).user.username).toBe("disabled_email");
  });

  it("rejects email registration when email is disabled", async () => {
    const { auth } = createAuth({ emailEnabled: false });
    await expect(
      auth.register({
        username: "disabled_email2",
        email: "blocked@example.com",
        password: "securepass12"
      })
    ).rejects.toThrow(/Email is not enabled/);
  });

  it("rejects email-only auth actions when email is disabled", async () => {
    const { auth } = createAuth({ emailEnabled: false });
    await auth.register({ username: "disabled_actions", password: "securepass12" });
    expect(() => auth.verifyEmail("token")).toThrow(/Email is not enabled/);
    await expect(auth.resendVerification("disabled_actions", "securepass12")).rejects.toThrow(
      /Email is not enabled/
    );
    await expect(auth.changeEmail("missing", "new@example.com", "securepass12")).rejects.toThrow(
      /Email is not enabled/
    );
  });

  it("registers users without email and allows immediate login", async () => {
    const { auth, sendEmail } = createAuth();
    const result = await auth.register({
      username: "no_email",
      password: "securepass12"
    });

    expect(result.user.email).toBeNull();
    expect(result.user.emailVerified).toBe(true);
    expect(result.verificationToken).toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();

    const session = await auth.login("no_email", "securepass12");
    expect(session.user.username).toBe("no_email");
  });

  it("registers users and sends verification email", async () => {
    const { auth, sendEmail } = createAuth();
    const result = await auth.register({
      username: "tester",
      email: "Tester@Example.com",
      password: "securepass12"
    });

    expect(result.user.username).toBe("tester");
    expect(result.user.email).toBe("tester@example.com");
    expect(result.user.emailVerified).toBe(false);
    expect(result.verificationToken).toMatch(/^[0-9a-f]+$/);
    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("hides verification tokens when exposeVerificationToken is false", async () => {
    const { auth } = createAuth({ exposeVerificationToken: false });
    const result = await auth.register({
      username: "hidden",
      email: "hidden@example.com",
      password: "securepass12"
    });
    expect(result.verificationToken).toBeUndefined();
  });

  it("rejects invalid registration input", async () => {
    const { auth } = createAuth();
    await expect(auth.register({ username: "ab", email: "bad", password: "short" })).rejects.toThrow(AuthError);
    await expect(auth.register({ username: "ab", password: "short" })).rejects.toThrow(AuthError);
    await expect(
      auth.register({ username: "valid_user", email: "not-an-email", password: "securepass12" })
    ).rejects.toThrow(/Invalid email/);
    await expect(
      auth.register({ username: "valid_user", email: "user@example.com", password: "short" })
    ).rejects.toThrow(/at least 12/);
  });

  it("rejects duplicate username and email with a generic message", async () => {
    const { auth } = createAuth();
    await auth.register({ username: "dup", email: "one@example.com", password: "securepass12" });
    await expect(
      auth.register({ username: "dup", email: "two@example.com", password: "securepass12" })
    ).rejects.toThrow(/Registration failed/);
    await expect(
      auth.register({ username: "other", email: "one@example.com", password: "securepass12" })
    ).rejects.toThrow(/Registration failed/);
  });

  it("logs in verified users and rejects invalid credentials", async () => {
    const { auth } = createAuth();
    const { verificationToken } = await auth.register({
      username: "login_user",
      email: "login@example.com",
      password: "securepass12"
    });
    await expect(auth.login("login_user", "wrong-password")).rejects.toThrow(/Invalid username or password/);
    await expect(auth.login("login_user", "securepass12")).rejects.toThrow(/Invalid username or password/);

    auth.verifyEmail(verificationToken!);
    const session = await auth.login("login_user", "securepass12");
    expect(session.user.emailVerified).toBe(true);
    expect(session.sessionToken).toMatch(/^[0-9a-f]+$/);
  });

  it("replaces prior sessions when logging in again", async () => {
    const { auth } = createAuth();
    const { verificationToken } = await auth.register({
      username: "rotate_user",
      email: "rotate@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);
    const first = await auth.login("rotate_user", "securepass12");
    const second = await auth.login("rotate_user", "securepass12");
    expect(first.sessionToken).not.toBe(second.sessionToken);
    expect(auth.getUserBySession(first.sessionToken)).toBeUndefined();
    expect(auth.getUserBySession(second.sessionToken)?.username).toBe("rotate_user");
  });

  it("expires sessions and removes stale session tokens", async () => {
    let now = 1_000_000;
    const { auth } = createAuth({ now: () => now });
    const { verificationToken } = await auth.register({
      username: "session_user",
      email: "session@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);
    const { sessionToken } = await auth.login("session_user", "securepass12");

    expect(auth.getUserBySession(sessionToken)).toBeDefined();
    now += 60_001;
    expect(auth.getUserBySession(sessionToken)).toBeUndefined();
  });

  it("logs out active sessions", async () => {
    const { auth } = createAuth();
    const { verificationToken } = await auth.register({
      username: "logout_user",
      email: "logout@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);
    const { sessionToken } = await auth.login("logout_user", "securepass12");
    auth.logout(sessionToken);
    expect(auth.getUserBySession(sessionToken)).toBeUndefined();
  });

  it("verifies and expires email tokens", async () => {
    let now = 1_000_000;
    const { auth } = createAuth({ now: () => now });
    const { verificationToken } = await auth.register({
      username: "verify_user",
      email: "verify@example.com",
      password: "securepass12"
    });

    expect(() => auth.verifyEmail("missing-token")).toThrow(/Invalid verification token/);

    now += 24 * 60 * 60 * 1000 + 1;
    expect(() => auth.verifyEmail(verificationToken!)).toThrow(/expired/);

    const fresh = await auth.register({
      username: "verify_user2",
      email: "verify2@example.com",
      password: "securepass12"
    });
    const verified = auth.verifyEmail(fresh.verificationToken!);
    expect(verified.emailVerified).toBe(true);
  });

  it("rejects resend when the account has no email", async () => {
    const { auth } = createAuth();
    await auth.register({ username: "no_email_resend", password: "securepass12" });
    await expect(auth.resendVerification("no_email_resend", "securepass12")).rejects.toThrow(/No email address/);
  });

  it("resends verification emails for unverified users", async () => {
    const { auth, sendEmail } = createAuth();
    await auth.register({ username: "resend", email: "resend@example.com", password: "securepass12" });
    await expect(auth.resendVerification("resend", "wrong")).rejects.toThrow(/Invalid username or password/);

    const resent = await auth.resendVerification("resend", "securepass12");
    expect(resent.verificationToken).toBeDefined();
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("rejects resend when email is already verified", async () => {
    const { auth } = createAuth();
    const { verificationToken } = await auth.register({
      username: "verified",
      email: "verified@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);
    await expect(auth.resendVerification("verified", "securepass12")).rejects.toThrow(/already verified/);
  });

  it("hides resend verification tokens when exposeVerificationToken is false", async () => {
    const { auth } = createAuth({ exposeVerificationToken: false });
    await auth.register({ username: "hidden_resend", email: "hidden_resend@example.com", password: "securepass12" });
    expect(await auth.resendVerification("hidden_resend", "securepass12")).toEqual({});
  });

  it("updates profile display names", async () => {
    const { auth } = createAuth();
    const { verificationToken, user } = await auth.register({
      username: "profile_user",
      email: "profile@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);

    const cleared = auth.updateProfile(user.id, null);
    expect(cleared.displayName).toBeNull();

    const updated = auth.updateProfile(user.id, "  Display Name  ");
    expect(updated.displayName).toBe("Display Name");
    expect(() => auth.updateProfile(user.id, "x".repeat(65))).toThrow(/64 characters/);
  });

  it("adds email to accounts that were created without one", async () => {
    const { auth, sendEmail } = createAuth();
    const { user } = await auth.register({ username: "add_email_user", password: "securepass12" });
    const updated = await auth.changeEmail(user.id, "added@example.com", "securepass12");
    expect(updated.email).toBe("added@example.com");
    expect(updated.emailVerified).toBe(false);
    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("changes email and resets verification state", async () => {
    const { auth, sendEmail } = createAuth({ exposeVerificationToken: true });
    const { verificationToken, user } = await auth.register({
      username: "email_user",
      email: "email@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);

    await expect(auth.changeEmail(user.id, "bad-email", "securepass12")).rejects.toThrow(/Invalid email/);
    await expect(auth.changeEmail(user.id, "new@example.com", "wrong-password")).rejects.toThrow(/Invalid password/);

    await auth.register({ username: "other_email", email: "taken@example.com", password: "securepass12" });
    await expect(auth.changeEmail(user.id, "taken@example.com", "securepass12")).rejects.toThrow(
      /Unable to update email/
    );

    const updated = await auth.changeEmail(user.id, "new@example.com", "securepass12");
    expect(updated.email).toBe("new@example.com");
    expect(updated.emailVerified).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it("changes passwords and clears sessions", async () => {
    const { auth } = createAuth();
    const { verificationToken, user } = await auth.register({
      username: "password_user",
      email: "password@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);
    const { sessionToken } = await auth.login("password_user", "securepass12");

    await expect(auth.changePassword(user.id, "wrong", "newsecurepass1")).rejects.toThrow(/Invalid password/);
    await expect(auth.changePassword(user.id, "securepass12", "short")).rejects.toThrow(/at least 12/);

    await auth.changePassword(user.id, "securepass12", "newsecurepass1");
    expect(auth.getUserBySession(sessionToken)).toBeUndefined();
    expect((await auth.login("password_user", "newsecurepass1")).user.id).toBe(user.id);
  });

  it("deletes accounts after password confirmation", async () => {
    const { auth } = createAuth();
    const { verificationToken, user } = await auth.register({
      username: "delete_user",
      email: "delete@example.com",
      password: "securepass12"
    });
    auth.verifyEmail(verificationToken!);
    await expect(auth.deleteAccount(user.id, "wrong-password")).rejects.toThrow(/Invalid password/);
    await auth.deleteAccount(user.id, "securepass12");
    await expect(auth.changePassword(user.id, "securepass12", "newsecurepass1")).rejects.toThrow(/User not found/);
  });

  it("exposes AuthError name", () => {
    expect(new AuthError("boom").name).toBe("AuthError");
  });

  it("returns undefined for missing users from getPublicUser", () => {
    const { auth } = createAuth();
    expect((auth as unknown as { getPublicUser: (id: string) => unknown }).getPublicUser("missing")).toBeUndefined();
  });

  it("supports changeEmail when verification tokens are hidden", async () => {
    const db = openDatabase(":memory:");
    const visible = new AuthService({
      db,
      sendEmail: async () => {},
      appBaseUrl: "http://127.0.0.1:8787",
      sessionTtlMs: 60_000,
      exposeVerificationToken: true,
      emailEnabled: true
    });
    const { verificationToken, user } = await visible.register({
      username: "hidden_change",
      email: "hidden_change@example.com",
      password: "securepass12"
    });
    visible.verifyEmail(verificationToken!);

    const hidden = new AuthService({
      db,
      sendEmail: async () => {},
      appBaseUrl: "http://127.0.0.1:8787",
      sessionTtlMs: 60_000,
      exposeVerificationToken: false,
      emailEnabled: true
    });
    const updated = await hidden.changeEmail(user.id, "changed@example.com", "securepass12");
    expect(updated.email).toBe("changed@example.com");
  });
});
