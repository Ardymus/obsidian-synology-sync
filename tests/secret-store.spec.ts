import { obfuscate, deobfuscate, isObfuscated } from "../src/secret-store";

describe("secret-store", () => {
  it("round-trips an ASCII password", () => {
    const plain = "hunter2";
    const wrapped = obfuscate(plain);
    expect(wrapped).not.toBe(plain);
    expect(wrapped.startsWith("o1:")).toBe(true);
    expect(deobfuscate(wrapped)).toBe(plain);
  });

  it("round-trips a Unicode password", () => {
    const plain = "p@ss✓wørd—🔒";
    expect(deobfuscate(obfuscate(plain))).toBe(plain);
  });

  it("round-trips a long random-looking token", () => {
    const plain = "K4baHg95H3Co8ORYFm6TrjvD2CpJKd4URVpHon9hdLUvvuwq38Vail3WJ2fr3adfuLqFJ_s0j54DBK8K4sGdXA";
    expect(deobfuscate(obfuscate(plain))).toBe(plain);
  });

  it("returns empty for empty input on both sides", () => {
    expect(obfuscate("")).toBe("");
    expect(deobfuscate("")).toBe("");
  });

  it("passes legacy plaintext through deobfuscate unchanged (for one-shot migration)", () => {
    // During the migration window an unsuffixed value should be returned
    // as-is so callers see plaintext until the next save wraps it.
    expect(deobfuscate("plaintext-leftover")).toBe("plaintext-leftover");
  });

  it("returns empty on corrupted ciphertext rather than throwing", () => {
    // Truncated/invalid base64 should not crash callers — they will see an
    // empty password field and re-enter.
    expect(deobfuscate("o1:not_valid_base64$$$")).toBe("");
  });

  it("isObfuscated only matches the o1: prefix", () => {
    expect(isObfuscated("o1:abc")).toBe(true);
    expect(isObfuscated("abc")).toBe(false);
    expect(isObfuscated("")).toBe(false);
    expect(isObfuscated("o2:abc")).toBe(false);
  });

  it("produces output that does not contain the plaintext substring", () => {
    // Smoke test for the core threat model: opening data.json in a text
    // editor should not reveal the password by simple substring search.
    const plain = "VERY_SECRET_TOKEN";
    expect(obfuscate(plain).includes(plain)).toBe(false);
  });
});
