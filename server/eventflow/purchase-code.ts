import { randomBytes } from "node:crypto";
import type { PurchaseCodeIssued } from "../../shared/eventflow";
import { DomainError, assertEventScope } from "./engine";
import { decryptSensitiveJson, encryptSensitiveJson } from "./security";

export const PURCHASE_CODE_TTL_MS = 10 * 60 * 1000;
const PREFIX = "purchase-v1.";

export type PurchaseCodePayload = {
  purpose: "purchase-code-v1";
  eventId: string;
  guestId: string;
  guestInviteHash: string;
  expiresAt: string;
  nonce: string;
};

export function issuePurchaseCode(
  binding: Pick<PurchaseCodePayload, "eventId" | "guestId" | "guestInviteHash">,
  now: Date,
  inviteExpiresAt?: string
): PurchaseCodeIssued {
  const expiresAt = new Date(
    Math.min(
      now.getTime() + PURCHASE_CODE_TTL_MS,
      inviteExpiresAt ? Date.parse(inviteExpiresAt) : Infinity
    )
  ).toISOString();
  const payload: PurchaseCodePayload = {
    purpose: "purchase-code-v1",
    ...binding,
    expiresAt,
    nonce: randomBytes(16).toString("base64url"),
  };
  const code = PREFIX + encryptSensitiveJson(payload);
  return {
    code,
    path: `/merchant#purchase=${encodeURIComponent(code)}`,
    expiresAt,
  };
}

/** A purchase code is never a guest/staff/receipt login capability. */
export function readPurchaseCode(
  code: string,
  eventId: string,
  now: Date
): PurchaseCodePayload {
  let payload: PurchaseCodePayload;
  try {
    if (
      code.length > 2048 ||
      !code.startsWith(PREFIX) ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(
        code.slice(PREFIX.length)
      )
    )
      throw new Error("invalid envelope");
    payload = decryptSensitiveJson<PurchaseCodePayload>(
      code.slice(PREFIX.length)
    );
    if (
      !payload ||
      payload.purpose !== "purchase-code-v1" ||
      typeof payload.eventId !== "string" ||
      !payload.eventId ||
      payload.eventId.length > 36 ||
      typeof payload.guestId !== "string" ||
      !payload.guestId ||
      payload.guestId.length > 36 ||
      typeof payload.guestInviteHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(payload.guestInviteHash) ||
      typeof payload.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/u.test(payload.nonce) ||
      typeof payload.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(payload.expiresAt))
    )
      throw new Error("invalid payload");
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === "SECURE_STORAGE_UNAVAILABLE" &&
      !process.env.MANUS_JWT_SECRET
    )
      throw error;
    throw new DomainError(
      400,
      "PURCHASE_CODE_INVALID",
      "消費識別碼無效，請嘉賓重新出示"
    );
  }
  assertEventScope(eventId, payload.eventId);
  if (Date.parse(payload.expiresAt) <= now.getTime())
    throw new DomainError(
      410,
      "PURCHASE_CODE_EXPIRED",
      "消費識別碼已過期，請嘉賓重新出示"
    );
  if (Date.parse(payload.expiresAt) > now.getTime() + PURCHASE_CODE_TTL_MS)
    throw new DomainError(
      400,
      "PURCHASE_CODE_INVALID",
      "消費識別碼無效，請嘉賓重新出示"
    );
  return payload;
}
