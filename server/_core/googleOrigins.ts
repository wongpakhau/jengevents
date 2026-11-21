/**
 * Exact, canonical HTTPS origins approved for this deployment.
 *
 * Leave empty until deployment addresses are confirmed. Add e.g.
 * "https://app.example.com" (no path, trailing slash, query or fragment),
 * and register each `${origin}/api/auth/google/callback` with Google.
 * Do not add wildcards or derive this list from incoming request headers.
 */
export const GOOGLE_TRUSTED_ORIGINS: readonly string[] = [
  "https://eventflow-ctmsgwbx.manus.space",
];
