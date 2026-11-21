import type { CookieOptions, Response } from "express";

// Keep this independent of the Google and participant authentication modules.
export const GOOGLE_TRANSACTION_COOKIE = "__Host-eventflow_google_transaction";
export const GOOGLE_TRANSACTION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
};

/** Clear the browser's pending transaction; this cannot revoke an in-flight callback. */
export function clearGoogleTransactionCookie(res: Response): void {
  // SameSite is not part of cookie identity (name, host-only domain and path).
  // Lax Set-Cookie can be rejected in a cross-site Preview iframe, so expire
  // the Lax transaction with None/Secure instead of changing how it is issued.
  res.clearCookie(GOOGLE_TRANSACTION_COOKIE, {
    ...GOOGLE_TRANSACTION_COOKIE_OPTIONS,
    sameSite: "none",
  });
}
