import {
  PARTICIPANT_SESSION_SECONDS,
  type ParticipantStatus,
  type TemporaryParticipant,
} from "@shared/participant";

export const PARTICIPANT_MARKER_KEY = "eventflow.participant-session";
export const PARTICIPANT_INVITE_KEY = "eventflow.participant-invite";
export const PARTICIPANT_DEVICE_EVENT = "eventflow:participant-device";
const GUEST_INVITE_KEY = "eventflow.guest-invite";
const SESSION_MS = PARTICIPANT_SESSION_SECONDS * 1000;
export type ParticipantMarker = Pick<
  TemporaryParticipant,
  "id" | "issuedAt" | "expiresAt"
>;
type RememberedInvite = { sid: string; expiresAt: string; token: string };
let memoryMarker: ParticipantMarker | null = null;
let memoryInvite: RememberedInvite | null = null;
let memoryOnlyMarker = false;
let verifiedClock: ParticipantClock | null = null;
let clockIdentity: string | null = null;

function storage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return typeof window !== "undefined" ? window[kind] : null;
  } catch {
    return null;
  }
}
function readStored(kind: "localStorage" | "sessionStorage", key: string) {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function removeStored(kind: "localStorage" | "sessionStorage", key: string) {
  try {
    storage(kind)?.removeItem(key);
  } catch {
    /* Private browsing may block storage. */
  }
}
function signalDeviceChange() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(PARTICIPANT_DEVICE_EVENT));
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function markerFrom(value: unknown): ParticipantMarker | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id) ||
    !timestamp(raw.issuedAt) ||
    !timestamp(raw.expiresAt) ||
    Date.parse(raw.expiresAt) - Date.parse(raw.issuedAt) !== SESSION_MS
  )
    return null;
  return { id: raw.id, issuedAt: raw.issuedAt, expiresAt: raw.expiresAt };
}

/** Runtime validation, never treating staff roles, malformed JSON or errors as logout. */
export function validateParticipantStatus(value: unknown): ParticipantStatus {
  if (!value || typeof value !== "object")
    throw new Error("臨時登入狀態回應不正確，請重試。");
  const raw = value as Record<string, unknown>;
  if (
    !timestamp(raw.serverNow) ||
    (raw.expired !== undefined && typeof raw.expired !== "boolean")
  )
    throw new Error("臨時登入狀態回應不正確，請重試。");
  if (raw.session === null)
    return {
      session: null,
      serverNow: raw.serverNow,
      ...(raw.expired !== undefined ? { expired: raw.expired as boolean } : {}),
    };
  const marker = markerFrom(raw.session);
  const role = (raw.session as Record<string, unknown> | undefined)?.role;
  if (
    !marker ||
    role !== "participant" ||
    raw.expired === true ||
    Date.parse(marker.issuedAt) > Date.parse(raw.serverNow) ||
    Date.parse(marker.expiresAt) <= Date.parse(raw.serverNow)
  )
    throw new Error("臨時登入身份或截止時間無效，請重新確認。");
  return {
    session: { ...marker, role: "participant" },
    serverNow: raw.serverNow,
  };
}

export type ParticipantClock = {
  now: () => number;
  remaining: (session: ParticipantMarker) => number;
  offset: number;
};
/** Server-calibrated and non-decreasing. Wall offset additionally covers suspended devices. */
export function createParticipantClock(
  serverNow: string,
  monotonic: () => number = () => performance.now(),
  wall: () => number = () => Date.now()
): ParticipantClock {
  const anchor = Date.parse(serverNow);
  if (!Number.isFinite(anchor)) throw new Error("伺服器時間無效。");
  const start = monotonic();
  const offset = anchor - wall();
  let last = anchor;
  const now = () =>
    (last = Math.max(
      last,
      anchor + Math.max(0, monotonic() - start),
      wall() + offset
    ));
  return {
    now,
    remaining: session => Math.max(0, Date.parse(session.expiresAt) - now()),
    offset,
  };
}
export function participantNow() {
  return verifiedClock?.now() ?? Date.now();
}
export function hasParticipantDeviceMarker() {
  try {
    const target = storage("localStorage");
    if (target)
      return (
        (memoryOnlyMarker && memoryMarker !== null) ||
        target.getItem(PARTICIPANT_MARKER_KEY) !== null ||
        target.getItem(PARTICIPANT_INVITE_KEY) !== null
      );
  } catch {
    /* Use memory only when storage is genuinely unavailable. */
  }
  return memoryMarker !== null || memoryInvite !== null;
}
export function getRememberedParticipant(): ParticipantMarker | null {
  const target = storage("localStorage");
  if (!target || memoryOnlyMarker) return memoryMarker;
  try {
    const raw = target.getItem(PARTICIPANT_MARKER_KEY);
    return raw ? markerFrom(JSON.parse(raw)) : null;
  } catch {
    return memoryMarker;
  }
}
function readInvite(): RememberedInvite | null {
  try {
    const raw = readStored("localStorage", PARTICIPANT_INVITE_KEY);
    const value = raw ? JSON.parse(raw) : memoryInvite;
    return value &&
      typeof value.sid === "string" &&
      timestamp(value.expiresAt) &&
      isSafeParticipantInviteToken(value.token)
      ? { sid: value.sid, expiresAt: value.expiresAt, token: value.token }
      : null;
  } catch {
    return null;
  }
}

/** On remote identity replacement, never erase the new tab's localStorage marker/invite. */
export function clearParticipantTab() {
  removeStored("sessionStorage", GUEST_INVITE_KEY);
  if (typeof window === "undefined") return;
  // A fragment belongs to this temporary device only when called with temporary presence.
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  hash.delete("invite");
  hash.delete("claim");
  const fragment = hash.toString();
  if (fragment !== window.location.hash.replace(/^#/, "")) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${fragment ? `#${fragment}` : ""}`
    );
  }
}
function clearGuestMaterial() {
  removeStored("localStorage", GUEST_INVITE_KEY);
  clearParticipantTab();
}
/** Only temporary material; unrelated non-temporary guest storage is never removed. */
export function clearParticipantDevice(
  temporaryPresence = hasParticipantDeviceMarker()
) {
  if (temporaryPresence) clearGuestMaterial();
  removeStored("localStorage", PARTICIPANT_INVITE_KEY);
  removeStored("sessionStorage", PARTICIPANT_INVITE_KEY);
  removeStored("localStorage", PARTICIPANT_MARKER_KEY);
  memoryInvite = null;
  memoryMarker = null;
  memoryOnlyMarker = false;
  signalDeviceChange();
}

/** Minimal non-authoritative device marker, never a JWT, name, phone or authorization. */
export function rememberParticipant(session: TemporaryParticipant) {
  const marker = markerFrom(session);
  if (!marker || session.role !== "participant")
    throw new Error("不能保存無效的臨時身份。");
  const previous = getRememberedParticipant();
  if (
    previous?.id === marker.id &&
    (previous.issuedAt !== marker.issuedAt ||
      previous.expiresAt !== marker.expiresAt)
  )
    throw new Error("臨時身份截止時間不能延長，請重新確認。");
  if (
    (previous && previous.id !== marker.id) ||
    (hasParticipantDeviceMarker() && !previous)
  ) {
    clearGuestMaterial();
    removeStored("localStorage", PARTICIPANT_INVITE_KEY);
    memoryInvite = null;
  }
  // Do not rewrite a valid marker on GET/start reuse: no sliding expiry/storage churn.
  if (previous?.id === marker.id) return;
  memoryMarker = marker;
  try {
    const target = storage("localStorage");
    memoryOnlyMarker = !target;
    target?.setItem(PARTICIPANT_MARKER_KEY, JSON.stringify(marker));
  } catch {
    memoryOnlyMarker = true;
  }
  signalDeviceChange();
}

async function participantRequest(
  action: "session" | "start",
  signal?: AbortSignal
): Promise<ParticipantStatus> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const mutation = action !== "session";
    const response = await fetch(`/api/auth/participant/${action}`, {
      method: mutation ? "POST" : "GET",
      credentials: "include",
      mode: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      ...(mutation
        ? { headers: { "Content-Type": "application/json" }, body: "{}" }
        : {}),
    });
    if (!response.ok)
      throw new Error(`未能確認臨時登入（${response.status}），請重試。`);
    const status = validateParticipantStatus(
      await response.json().catch(() => {
        throw new Error("臨時登入狀態回應不正確，請重試。");
      })
    );
    const identity = status.session?.id ?? null;
    const anchor =
      identity && identity === clockIdentity && verifiedClock
        ? Math.max(Date.parse(status.serverNow), verifiedClock.now())
        : Date.parse(status.serverNow);
    verifiedClock = createParticipantClock(new Date(anchor).toISOString());
    clockIdentity = identity;
    return status;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
export function getParticipantStatus(signal?: AbortSignal) {
  return participantRequest("session", signal);
}
export async function startParticipantSession(): Promise<ParticipantStatus> {
  const status = await participantRequest("start");
  if (!status.session) throw new Error("未能建立臨時身份，請重試。");
  if (!getRememberedParticipant()) clearGuestMaterial();
  rememberParticipant(status.session);
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    removeStored(kind, "manus-cookie");
    removeStored(kind, "eventflow-pending-staff-invite");
  }
  return status;
}
export async function endParticipantSession(): Promise<void> {
  const presence = hasParticipantDeviceMarker();
  const response = await fetch("/api/auth/participant/logout", {
    method: "POST",
    credentials: "include",
    mode: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok)
    throw new Error(`未能登出臨時帳戶（${response.status}），請重試。`);
  const result: unknown = await response.json().catch(() => {
    throw new Error("登出回應不正確，請重試。");
  });
  if (
    !result ||
    typeof result !== "object" ||
    !("success" in result) ||
    result.success !== true
  )
    throw new Error("伺服器未確認登出，請重試。");
  clearParticipantDevice(presence);
  verifiedClock = null;
  clockIdentity = null;
}

// Existing capability generation is randomBytes(32).toString("base64url").
export function isSafeParticipantInviteToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
export function rememberParticipantInvite(
  token: string,
  session: TemporaryParticipant
) {
  const marker = markerFrom(session);
  const remembered = getRememberedParticipant();
  if (
    !marker ||
    session.role !== "participant" ||
    !isSafeParticipantInviteToken(token) ||
    !remembered ||
    marker.id !== remembered.id ||
    marker.issuedAt !== remembered.issuedAt ||
    marker.expiresAt !== remembered.expiresAt ||
    Date.parse(marker.expiresAt) <= participantNow()
  )
    throw new Error("請先確認仍有效的臨時身份，再保存你的嘉賓邀請。");
  memoryInvite = { sid: marker.id, expiresAt: marker.expiresAt, token };
  try {
    storage("localStorage")?.setItem(
      PARTICIPANT_INVITE_KEY,
      JSON.stringify(memoryInvite)
    );
  } catch {
    /* Memory fallback. */
  }
}
export function participantInvitePath(
  session: TemporaryParticipant
): string | null {
  const marker = markerFrom(session);
  const remembered = getRememberedParticipant();
  const invite = readInvite();
  if (
    !marker ||
    session.role !== "participant" ||
    !remembered ||
    remembered.id !== marker.id ||
    remembered.issuedAt !== marker.issuedAt ||
    remembered.expiresAt !== marker.expiresAt ||
    !invite ||
    invite.sid !== marker.id ||
    invite.expiresAt !== marker.expiresAt ||
    Date.parse(marker.expiresAt) <= participantNow()
  )
    return null;
  return `/guest#invite=${encodeURIComponent(invite.token)}`;
}

/** Strict local-only allowlist. Capability validity is finally verified by /guest. */
export function participantLinkPath(
  raw: string,
  origin = window.location.origin
): string {
  const value = raw.trim();
  if (
    !value ||
    /[\s\\\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("//") ||
    !(value.startsWith("/") || /^https?:\/\//i.test(value))
  )
    throw new Error("只接受本站的大會登記或個人嘉賓邀請完整連結。");
  const url = new URL(value, origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !["https:", "http:"].includes(url.protocol) ||
    url.search
  )
    throw new Error("不接受外站、後台或含查詢參數的連結。");
  // Reject URL parser normalization (dot segments, encoded path separators, empty query/hash).
  const literalPath = value.startsWith("/")
    ? value.split(/[?#]/, 1)[0]
    : value.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/, 1)[0];
  if (literalPath !== url.pathname || value.includes("?"))
    throw new Error("大會連結格式不正確。");
  if (
    /^\/register\/[A-Za-z0-9_-]{1,160}$/.test(url.pathname) &&
    !value.includes("#")
  )
    return url.pathname;
  if (url.pathname === "/guest" && /^#invite=[A-Za-z0-9_-]{43}$/.test(url.hash))
    return `${url.pathname}${url.hash}`;
  throw new Error("這不是大會登記或個人嘉賓邀請連結；不能前往工作人員後台。");
}
