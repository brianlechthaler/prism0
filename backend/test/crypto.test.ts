import { afterEach, describe, expect, it, vi } from "vitest";

const scryptSyncMock = vi.hoisted(() => vi.fn<typeof import("node:crypto").scryptSync>());

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scryptSync: ((password, salt, keylen, options) => {
      const mocked = scryptSyncMock(password, salt, keylen, options);
      if (mocked) return mocked;
      return actual.scryptSync(password, salt, keylen, options);
    }) as typeof actual.scryptSync
  };
});

import { hashPassword, randomSlug, randomToken, verifyPassword } from "../src/crypto.js";

describe("crypto", () => {
  afterEach(() => {
    scryptSyncMock.mockReset();
  });

  it("hashes and verifies passwords", () => {
    const stored = hashPassword("secret-password");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPassword("secret-password", stored)).toBe(true);
    expect(verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("rejects malformed stored password hashes", () => {
    expect(verifyPassword("secret-password", "not-valid")).toBe(false);
    expect(verifyPassword("secret-password", "abc:")).toBe(false);
    expect(verifyPassword("secret-password", ":def")).toBe(false);
  });

  it("rejects stored hashes with mismatched digest length", () => {
    const stored = hashPassword("secret-password");
    const [saltHex, hashHex] = stored.split(":");
    scryptSyncMock.mockReturnValueOnce(Buffer.from([1, 2, 3]));
    expect(verifyPassword("secret-password", `${saltHex}:${hashHex}`)).toBe(false);
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
