import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVerificationEmail, createEmailSender } from "../src/email.js";

describe("email", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds verification email links without trailing slashes", () => {
    const email = buildVerificationEmail("http://127.0.0.1:8787/", "token-123");
    expect(email.subject).toBe("Verify your prism0 account");
    expect(email.text).toContain("http://127.0.0.1:8787/verify-email?token=token-123");
    expect(email.text).toContain("expires in 24 hours");
  });

  it("logs console email messages", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const send = createEmailSender({ mode: "console" });
    await send({ to: "user@example.com", subject: "Hello", text: "Body" });
    expect(logSpy).toHaveBeenCalledWith("[email] to=user@example.com subject=Hello\nBody");
  });
});
