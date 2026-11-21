import { OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/** Return only a same-origin, root-relative application path. */
function safeLoginReturnPath(value: string): string {
  try {
    if (!value.startsWith("/") || value.startsWith("//")) return "/";
    const decoded = decodeURIComponent(value);
    if (/^[\/]{2}|[\\\u0000-\u001f\u007f]/.test(decoded)) return "/";
    const url = new URL(value, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      url.pathname.startsWith("/api/")
    )
      return "/";
    url.searchParams.delete("authError");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/** Start direct Google OAuth only from an event handler or redirect effect. */
export const startLogin = (returnTo?: string) => {
  const safePath = safeLoginReturnPath(
    returnTo ??
      `${window.location.pathname}${window.location.search}${window.location.hash}`
  );
  window.location.assign(
    `/api/auth/google/start?returnTo=${encodeURIComponent(safePath)}`
  );
};

// Preserve the original Manus OAuth entry point for existing integrations.
// It has side effects: minting a nonce, writing the OAuth state cookie and
// navigating immediately. Never call it during render or use it as an href.
export const startManusLogin = () => {
  const oauthPortalUrl = window.__MANUS_CONFIG__?.oauthPortalUrl;
  const appId = window.__MANUS_CONFIG__?.projectId;
  if (!oauthPortalUrl || !appId)
    throw new Error("Manus login is not configured");
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  const nonce = crypto.randomUUID();
  document.cookie = `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; Max-Age=600; SameSite=None; Secure`;
  const state = encodeOAuthState({ redirectUri, nonce });

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("responseType", "code");

  window.location.href = url.toString();
};
