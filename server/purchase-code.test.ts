import { beforeAll, describe, expect, it } from "vitest";
import {
  issuePurchaseCode,
  readPurchaseCode,
  PURCHASE_CODE_TTL_MS,
} from "./eventflow/purchase-code";
import { encryptSensitiveJson, sha256 } from "./eventflow/security";

const now = new Date("2027-01-01T00:00:00.000Z");
const binding = {
  eventId: "event",
  guestId: "guest",
  guestInviteHash: sha256("raw-login-invite"),
};
beforeAll(() => {
  process.env.MANUS_JWT_SECRET = "purchase-code-test-secret";
});

describe("purchase codes", () => {
  it("encrypts a purpose-bound random payload without exposing the login invite or PII", () => {
    const issued = issuePurchaseCode(binding, now);
    const other = issuePurchaseCode(binding, now);
    expect(issued.code).not.toBe(other.code);
    expect(issued.path).toBe(
      `/merchant#purchase=${encodeURIComponent(issued.code)}`
    );
    expect(issued.code).not.toContain("raw-login-invite");
    const payload = readPurchaseCode(issued.code, "event", now);
    expect(payload).toMatchObject({
      ...binding,
      purpose: "purchase-code-v1",
      expiresAt: issued.expiresAt,
    });
    expect(Object.keys(payload).sort()).toEqual([
      "eventId",
      "expiresAt",
      "guestId",
      "guestInviteHash",
      "nonce",
      "purpose",
    ]);
    expect(Date.parse(issued.expiresAt) - now.getTime()).toBe(
      PURCHASE_CODE_TTL_MS
    );
  });
  it("caps expiry at the guest capability expiry", () => {
    const expiresAt = "2027-01-01T00:01:00.000Z";
    expect(issuePurchaseCode(binding, now, expiresAt).expiresAt).toBe(
      expiresAt
    );
  });
  it("rejects expired and cross-event codes", () => {
    const { code } = issuePurchaseCode(binding, now);
    expect(() => readPurchaseCode(code, "other", now)).toThrowError(
      expect.objectContaining({ code: "CROSS_EVENT" })
    );
    expect(() =>
      readPurchaseCode(
        code,
        "event",
        new Date(now.getTime() + PURCHASE_CODE_TTL_MS)
      )
    ).toThrowError(expect.objectContaining({ code: "PURCHASE_CODE_EXPIRED" }));
  });
  it.each([
    "raw-login-invite",
    "purchase-v1.bad.cipher.text",
    "purchase-v1.a.b.c.extra",
    "",
  ])("rejects forged or non-purchase input %s", code => {
    expect(() => readPurchaseCode(code, "event", now)).toThrowError(
      expect.objectContaining({ code: "PURCHASE_CODE_INVALID" })
    );
  });
  it("rejects tampering, encrypted idempotent replies, and different purposes", () => {
    const { code } = issuePurchaseCode(binding, now);
    expect(() =>
      readPurchaseCode(code.slice(0, -8) + "AAAAAAAA", "event", now)
    ).toThrow();
    for (const value of [
      { token: "raw-login-invite" },
      {
        ...binding,
        purpose: "staff",
        expiresAt: "2027-01-01T00:10:00.000Z",
        nonce: "x".repeat(22),
      },
    ]) {
      expect(() =>
        readPurchaseCode(
          "purchase-v1." + encryptSensitiveJson(value),
          "event",
          now
        )
      ).toThrowError(
        expect.objectContaining({ code: "PURCHASE_CODE_INVALID" })
      );
    }
  });
});
