/**
 * Exact, canonical HTTPS origins approved for this deployment.
 *
 * Add only confirmed deployment addresses (no path, trailing slash,
 * query or fragment),
 * and register each `${origin}/api/auth/google/callback` with Google.
 * Do not add wildcards or derive this list from incoming request headers.
 */
export const GOOGLE_TRUSTED_ORIGINS: readonly string[] = [
  "https://eventflow-ctmsgwbx.manus.space",
  "https://bp.jengevents.com",
];
