import { describe, expect, it } from "vitest";
import { hashSessionToken, hashPassword, randomSlug, randomToken, verifyPassword } from "../src/crypto.js";

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const stored = await hashPassword("secret-password");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyPassword("secret-password", stored)).toBe(true);
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("rejects malformed stored password hashes", async () => {
    expect(await verifyPassword("secret-password", "not-valid")).toBe(false);
    expect(await verifyPassword("secret-password", "abc:")).toBe(false);
    expect(await verifyPassword("secret-password", ":def")).toBe(false);
  });

  it("rejects stored hashes with mismatched digest length", async () => {
    const stored = await hashPassword("secret-password");
    const [saltHex] = stored.split(":");
    expect(await verifyPassword("secret-password", `${saltHex}:ab`)).toBe(false);
    expect(await verifyPassword("secret-password", `${saltHex}:${"00".repeat(63)}`)).toBe(false);
  });

  it("hashes session tokens deterministically", () => {
    const token = "abc123";
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("generates random tokens and slugs", () => {
    const token = randomToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const shortToken = randomToken(8);
    expect(shortToken).toMatch(/^[0-9a-f]{16}$/);

    const slug = randomSlug();
    expect(slug).toMatch(/^[a-z0-9]{10}$/);

    const longSlug = randomSlug(20);
    expect(longSlug).toHaveLength(20);
  });
});
