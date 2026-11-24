/** Username/password login shared by the browser forms and the server routes. */
export const LOCAL_SESSION_COOKIE = "eventflow_local_session";
export const LOCAL_LOGIN_PATH = "/api/auth/local/login";
export const LOCAL_LOGOUT_PATH = "/api/auth/local/logout";

/** Lower-case letters, digits, dot, underscore and dash; 3–32 characters. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

export type LocalAccountKind = "staff" | "member";

export type LocalLoginResult =
  | { kind: "staff"; returnTo: string; displayName: string }
  | { kind: "member"; path: string; displayName: string };

/** Managed by system owners/admins on the access page. Never includes hashes. */
export type LocalAccount = {
  id: string;
  username: string;
  displayName: string;
  kind: LocalAccountKind;
  active: boolean;
  /** Staff accounts map to a users row so event roles can be assigned. */
  userId: number | null;
  eventId: string | null;
  eventName: string | null;
  guestId: string | null;
  guestName: string | null;
  memberCode: string | null;
  assignments: {
    eventId: string;
    eventName: string;
    role: string;
    merchantId: string | null;
    merchantName: string | null;
  }[];
  createdAt: string;
  lastLoginAt: string | null;
};

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}
