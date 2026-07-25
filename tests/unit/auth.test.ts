import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, safeNextPath } from "../../src/auth.js";

describe("password hashing", () => {
  it("never stores the password itself", async () => {
    const { hash, salt } = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct");
    expect(salt).not.toContain("correct");
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("salts every hash so identical passwords do not collide", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("accepts the right password and rejects the wrong one", async () => {
    const { hash, salt } = await hashPassword("s3cret");
    await expect(verifyPassword("s3cret", hash, salt)).resolves.toBe(true);
    await expect(verifyPassword("s3cret ", hash, salt)).resolves.toBe(false);
    await expect(verifyPassword("S3cret", hash, salt)).resolves.toBe(false);
    await expect(verifyPassword("", hash, salt)).resolves.toBe(false);
  });

  it("rejects instead of throwing when the stored hash is malformed", async () => {
    await expect(verifyPassword("s3cret", "not-hex", "also-not-hex")).resolves.toBe(false);
    await expect(verifyPassword("s3cret", "", "")).resolves.toBe(false);
  });

  it("handles unicode and long passwords", async () => {
    const password = "contraseña-🏀-" + "x".repeat(500);
    const { hash, salt } = await hashPassword(password);
    await expect(verifyPassword(password, hash, salt)).resolves.toBe(true);
  });
});

describe("post-login redirect target", () => {
  it("keeps a relative path", () => {
    expect(safeNextPath("/admin/keys")).toBe("/admin/keys");
    expect(safeNextPath("/")).toBe("/");
  });

  it("refuses to bounce the user off-site", () => {
    // Classic open-redirect payloads.
    expect(safeNextPath("https://evil.example/phish")).toBe("/");
    expect(safeNextPath("//evil.example/phish")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });

  it("does not send the user back to the login page", () => {
    expect(safeNextPath("/login")).toBe("/");
  });
});
