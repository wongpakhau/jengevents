import type { Guest } from "../../shared/eventflow";
import { isExcludedFromEvent } from "../../shared/eventflow";
import { registrationPhone } from "../../shared/registration";
import {
  normalizedRosterText,
  ROSTER_CANDIDATE_LIMIT,
  type RosterMatchView,
  type RosterNameDirectoryView,
  type RosterSearchView,
} from "../../shared/roster";
import { DomainError, type EventAggregate } from "./engine";
import { identityName } from "./roster-match";

type ClaimOptions = { confirmedGuestId: string; actorScope: string; now: Date };

function reject(): never {
  throw new DomainError(
    400,
    "QUICK_MATCH_FAILED",
    "未能核對本人紀錄，請使用原嘉賓連結或到簽到台。這不是電話一次性密碼驗證。"
  );
}

function assertOpen(state: EventAggregate): void {
  if (
    (state.event.mode !== "attendance" && state.event.mode !== "full") ||
    !Array.isArray(state.guests) ||
    !Array.isArray(state.tables)
  )
    reject();
  if (!state.event.registrationOpen || state.event.status === "closed")
    throw new DomainError(403, "REGISTRATION_CLOSED", "此活動暫未開放登記");
}

function active(state: EventAggregate, guest: Guest): boolean {
  return (
    guest.eventId === state.event.id &&
    guest.tenantId === state.event.tenantId &&
    !isExcludedFromEvent(state.event, guest)
  );
}

function nameInput(value: unknown): string {
  if (typeof value !== "string" || value.length > 120 || !value.trim())
    reject();
  return identityName(value);
}

/** Self-reported recognition must never recover someone else's commerce identity. */
function protectedHistory(state: EventAggregate, guest: Guest): boolean {
  if (state.event.mode !== "full") return false;
  if (
    guest.chances !== 0 ||
    !Array.isArray(state.receipts) ||
    !Array.isArray(state.ledger) ||
    !Array.isArray(state.draws)
  )
    return true;
  if (
    state.receipts.some(
      receipt =>
        !receipt ||
        (receipt.guestId !== null && typeof receipt.guestId !== "string") ||
        receipt.guestId === guest.id
    )
  )
    return true;
  if (
    state.ledger.some(
      entry =>
        !entry ||
        typeof entry.guestId !== "string" ||
        entry.guestId === guest.id
    )
  )
    return true;
  return state.draws.some(
    draw =>
      !draw ||
      !draw.winner ||
      typeof draw.winner.id !== "string" ||
      typeof draw.winner.ticket !== "string" ||
      typeof draw.winnerGuestId !== "string" ||
      !Array.isArray(draw.snapshot) ||
      draw.winnerGuestId === guest.id ||
      draw.winner.id === guest.id ||
      draw.winner.ticket === guest.ticket ||
      draw.snapshot.some(
        entry =>
          !entry ||
          typeof entry.guestId !== "string" ||
          typeof entry.ticket !== "string" ||
          entry.guestId === guest.id ||
          entry.ticket === guest.ticket
      )
  );
}

function tableView(
  state: EventAggregate,
  guest: Guest
): RosterMatchView["table"] {
  if (guest.tableId === null && guest.seat === null) return null;
  const matches = state.tables.filter(
    table =>
      table.id === guest.tableId &&
      table.eventId === state.event.id &&
      table.tenantId === state.event.tenantId
  );
  const table = matches[0];
  if (
    matches.length !== 1 ||
    !table ||
    !Number.isSafeInteger(table.number) ||
    table.number < 1 ||
    !Number.isSafeInteger(table.capacity) ||
    !Number.isInteger(guest.seat) ||
    guest.seat === null ||
    guest.seat < 1 ||
    guest.seat > Math.min(table.capacity, 12) ||
    state.guests.some(
      other =>
        other.id !== guest.id &&
        active(state, other) &&
        other.tableId === guest.tableId &&
        other.seat === guest.seat
    )
  )
    reject();
  return { number: table.number, label: table.label, seat: guest.seat };
}

function candidates(
  state: EventAggregate,
  name: string,
  replay?: ClaimOptions
): Guest[] {
  return state.guests.filter(guest => {
    if (
      !active(state, guest) ||
      identityName(guest.name) !== name ||
      guest.rosterClaimBlocked ||
      protectedHistory(state, guest) ||
      state.guests.filter(other => other.id === guest.id).length !== 1
    )
      return false;
    const source = normalizedRosterText(guest.rosterKey);
    if (
      source &&
      state.guests.some(
        other =>
          other.id !== guest.id &&
          active(state, other) &&
          normalizedRosterText(other.rosterKey) === source
      )
    )
      return false;
    if (
      (guest.rosterClaimedAt || guest.rosterClaimedBy) &&
      !(
        replay &&
        guest.id === replay.confirmedGuestId &&
        guest.rosterClaimedAt &&
        guest.rosterClaimedBy === replay.actorScope
      )
    )
      return false;
    try {
      tableView(state, guest);
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  });
}

function publicView(state: EventAggregate, guest: Guest): RosterMatchView {
  return {
    guestId: guest.id,
    name: guest.name,
    chapter: guest.chapter || "",
    invitedBy: guest.invitedBy || "",
    classType: guest.classType || "",
    classNumber: guest.classNumber || "",
    table: tableView(state, guest),
  };
}

/** The user requested the same public name-only list for all event organizations. */
export function quickGuestNames(
  state: EventAggregate,
  sort: "name" | "phone" = "name"
): RosterNameDirectoryView {
  assertOpen(state);
  const names = new Map<string, { name: string; phone: string; index: number }>();
  let index = 0;
  for (const guest of state.guests) {
    if (!active(state, guest) || typeof guest.name !== "string") continue;
    const name = guest.name.trim();
    const key = normalizedRosterText(name);
    if (name && name.length <= 120 && key && !names.has(key)) {
      let phone = "";
      try {
        if (guest.phone.trim()) phone = registrationPhone(guest.phone);
      } catch {
        // Malformed legacy phones behave like an empty phone for ordering only.
      }
      names.set(key, { name, phone, index });
      index += 1;
    }
  }
  if (names.size > 10_000)
    throw new DomainError(503, "DIRECTORY_TOO_LARGE", "請到簽到台查詢名單");
  const entries = [...names.values()];
  entries.sort((a, b) => {
    if (sort === "phone") {
      const aEmpty = !a.phone;
      const bEmpty = !b.phone;
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      if (a.phone !== b.phone) return a.phone.localeCompare(b.phone);
    }
    return (
      a.name.localeCompare(b.name, "zh-Hant", { sensitivity: "base" }) ||
      a.index - b.index
    );
  });
  return {
    names: entries.map(entry => entry.name),
  };
}

export function quickGuestSearch(
  state: EventAggregate,
  value: unknown
): RosterSearchView {
  assertOpen(state);
  const found = candidates(state, nameInput(value));
  if (found.length > ROSTER_CANDIDATE_LIMIT)
    return { candidates: [], requiresRefinement: true };
  return {
    candidates: found.map(guest => publicView(state, guest)),
    requiresRefinement: false,
  };
}

/** Includes blocked/claimed/protected rows: no walk-in bypass for existing identities. */
export function assertQuickNameIsNew(
  state: EventAggregate,
  value: unknown
): void {
  assertOpen(state);
  const name = nameInput(value);
  if (
    state.guests.some(
      guest => active(state, guest) && identityName(guest.name) === name
    )
  )
    throw new DomainError(
      409,
      "ROSTER_NAME_EXISTS",
      "活動名單已有這個名字，請選本人紀錄、使用原嘉賓連結或到簽到台；不會重複新增。"
    );
}

/** Must be called on the current, locked aggregate immediately before issuing an invite. */
export function claimQuickGuest(
  state: EventAggregate,
  input: { name: unknown; phone: unknown },
  options: ClaimOptions
): Guest {
  assertOpen(state);
  if (
    !options.confirmedGuestId ||
    options.confirmedGuestId.length > 80 ||
    !options.actorScope.trim()
  )
    reject();
  const found = candidates(state, nameInput(input.name), options);
  if (found.length > ROSTER_CANDIDATE_LIMIT) reject();
  const guest = found.find(item => item.id === options.confirmedGuestId);
  if (!guest || typeof guest.phone !== "string") reject();
  let phone: string;
  try {
    phone = registrationPhone(input.phone);
  } catch {
    reject();
  }
  if (guest.phone.trim()) {
    try {
      if (registrationPhone(guest.phone) !== phone) reject();
    } catch {
      reject();
    }
  }
  if (
    state.guests.some(
      other =>
        other.id !== guest.id &&
        active(state, other) &&
        other.phone?.trim() &&
        (() => {
          try {
            return registrationPhone(other.phone) === phone;
          } catch {
            return false;
          }
        })()
    )
  )
    reject();
  if (guest.rosterClaimedAt || guest.rosterClaimedBy) return { ...guest };
  return {
    ...guest,
    phone: guest.phone.trim() ? guest.phone : phone,
    rosterClaimedAt: options.now.toISOString(),
    rosterClaimedBy: options.actorScope,
  };
}
