/** Google direct login is hosted on this fixed, verified production origin. */
export const GOOGLE_PRODUCTION_ORIGIN = "https://bp.jengevents.com";

/** Keep development relative, but initiate production login on its cookie host. */
export function googleStartUrl(returnTo: string, production: boolean): string {
  const path = `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;
  return production ? `${GOOGLE_PRODUCTION_ORIGIN}${path}` : path;
}
