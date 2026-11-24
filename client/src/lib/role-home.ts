import type { EventMode, Role } from "@shared/eventflow";

/** Fixed, same-origin landing paths. The server allows exactly these for Google returnTo. */
export const STAFF_RETURN_PATHS = [
  "/",
  "/merchant",
  "/checkin",
  "/draw",
  "/guests",
  "/settlements",
] as const;
export type StaffReturnPath = (typeof STAFF_RETURN_PATHS)[number];

/** Where a staff account should land right after login for its event role. */
export function roleHome(
  role: Role | null | undefined,
  mode: EventMode = "full"
): StaffReturnPath {
  switch (role) {
    case "merchant":
      return mode === "attendance" ? "/" : "/merchant";
    case "checkin":
      return "/checkin";
    case "draw":
      return mode === "attendance" ? "/" : "/draw";
    case "guest_manager":
      return "/guests";
    default:
      return "/";
  }
}

export function roleHomeLabel(
  role: Role | null | undefined,
  mode: EventMode = "full"
): string {
  switch (roleHome(role, mode)) {
    case "/merchant":
      return "商戶掃碼開單";
    case "/checkin":
      return "現場簽到台";
    case "/draw":
      return "抽獎控制";
    case "/guests":
      return "嘉賓管理";
    default:
      return "活動總覽";
  }
}

/** Only the workspace root forwards; deliberately opened deep links stay put. */
export function shouldForwardFromRoot(
  location: string,
  role: Role | null | undefined,
  mode: EventMode = "full"
): boolean {
  return location === "/" && roleHome(role, mode) !== "/";
}

/** Google login may only return to a known staff path; anything else goes home. */
export function staffReturnPath(location: string): StaffReturnPath {
  return (STAFF_RETURN_PATHS as readonly string[]).includes(location)
    ? (location as StaffReturnPath)
    : "/";
}

export const GUEST_INVITE_STORAGE_KEY = "eventflow.guest-invite";

type StorageLike = Pick<Storage, "getItem">;

/**
 * A device that already remembers a personal guest invitation can open the
 * guest page directly; everyone else starts with the temporary account and a
 * scan of the event or personal invitation QR. Nothing here grants identity.
 */
export function guestEntryPath(
  local: StorageLike | null | undefined,
  session: StorageLike | null | undefined
): "/guest" | "/participant" {
  const read = (storage: StorageLike | null | undefined) => {
    try {
      return storage?.getItem(GUEST_INVITE_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  };
  return read(session) || read(local) ? "/guest" : "/participant";
}
