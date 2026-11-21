import type { Guest } from "../../shared/eventflow";
import { DomainError } from "./engine";

export type RosterFields = Pick<
  Guest,
  | "chapter"
  | "invitedBy"
  | "memberKind"
  | "rosterKey"
  | "rosterClaimBlocked"
  | "excludedFromEvent"
>;

export function validateRosterFields(
  body: Record<string, unknown>
): RosterFields {
  const result: RosterFields = {};
  for (const key of ["chapter", "invitedBy", "rosterKey"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length > 200) {
      throw new DomainError(
        400,
        "INVALID_ROSTER_FIELD",
        "分會、邀請人或名單編號格式不正確"
      );
    }
    result[key] = value.trim();
  }
  if (body.memberKind !== undefined) {
    if (
      typeof body.memberKind !== "string" ||
      !["", "core", "member", "guest"].includes(body.memberKind)
    ) {
      throw new DomainError(400, "INVALID_MEMBER_KIND", "嘉賓類別不正確");
    }
    result.memberKind = body.memberKind as Guest["memberKind"];
  }
  if (body.rosterClaimBlocked !== undefined) {
    if (typeof body.rosterClaimBlocked !== "boolean") {
      throw new DomainError(
        400,
        "INVALID_ROSTER_FIELD",
        "人工核對設定必須是布林值"
      );
    }
    result.rosterClaimBlocked = body.rosterClaimBlocked;
  }
  if (body.excludedFromEvent !== undefined) {
    if (typeof body.excludedFromEvent !== "boolean")
      throw new DomainError(
        400,
        "INVALID_ROSTER_FIELD",
        "保留設定必須是布林值"
      );
    result.excludedFromEvent = body.excludedFromEvent;
  }
  return result;
}

export function guestSelfView(guest: Guest): Guest {
  const {
    rosterClaimedBy: _actor,
    rosterKey: _key,
    excludedFromEvent: _excluded,
    ...safe
  } = guest;
  return {
    ...safe,
    group: "",
    note: "",
    ...(guest.rosterClaimedAt ? { email: "", phone: "" } : {}),
  };
}
