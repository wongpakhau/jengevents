import { normalizeMemberCode } from "@shared/eventflow";

/** The QR a guest shows: opens the merchant terminal with the member code. */
export function memberQrValue(memberCode: string, origin: string): string {
  return `${origin}/merchant#member=${encodeURIComponent(memberCode)}`;
}

/**
 * Accepts the member QR URL (`/merchant#member=CODE`) or a plainly typed
 * member code. Login invitations and other hashes are rejected.
 */
export function memberCodeFromQr(raw: string, origin: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !trimmed.startsWith("/")) {
    return normalizeMemberCode(trimmed);
  }
  try {
    const url = new URL(trimmed, origin);
    const expected = new URL(origin);
    if (
      url.origin !== expected.origin ||
      url.pathname !== "/merchant" ||
      url.username ||
      url.password
    )
      return null;
    const hash = new URLSearchParams(url.hash.slice(1));
    if (
      hash.getAll("member").length !== 1 ||
      hash.has("invite") ||
      hash.has("claim") ||
      hash.has("purchase")
    )
      return null;
    return normalizeMemberCode(hash.get("member"));
  } catch {
    return null;
  }
}
