/** Consume only the purpose-specific full QR URL, never a login invitation. */
export function purchaseCodeFromQr(raw: string, origin: string): string | null {
  try {
    const url = new URL(raw.trim(), origin);
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
      hash.getAll("purchase").length !== 1 ||
      hash.has("invite") ||
      hash.has("claim")
    )
      return null;
    const code = hash.get("purchase");
    return code && code.length <= 4096 ? code : null;
  } catch {
    return null;
  }
}
