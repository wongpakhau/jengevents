import { describe, expect, it } from "vitest";
import {
  hashPassword,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./_core/localAuth";
import { normalizeUsername } from "../shared/local-login";

describe("local account login helpers", () => {
  it("hashes passwords with a per-password salt and verifies them", async () => {
    const first = await hashPassword("pass1234");
    const second = await hashPassword("pass1234");
    expect(first).not.toContain("pass1234");
    expect(first).not.toEqual(second);
    expect(await verifyPassword("pass1234", first)).toBe(true);
    expect(await verifyPassword("wrong-pass", first)).toBe(false);
    expect(await verifyPassword("pass1234", "not-a-hash")).toBe(false);
  });
  it("normalizes and validates usernames and passwords", () => {
    expect(normalizeUsername("  Shop01 ")).toBe("shop01");
    expect(validateUsername("Shop01")).toBe("shop01");
    expect(() => validateUsername("a")).toThrow();
    expect(() => validateUsername("has space")).toThrow();
    expect(validatePassword("abcdef")).toBe("abcdef");
    expect(() => validatePassword("12345")).toThrow();
  });
});
