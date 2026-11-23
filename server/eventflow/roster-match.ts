import type { EventInfo, EventTable, Guest } from "../../shared/eventflow";
import { isExcludedFromEvent } from "../../shared/eventflow";
import {
  chapterOf,
  NO_CHAPTER,
  normalizedRosterText,
  ROSTER_CANDIDATE_LIMIT,
  type RosterNameDirectoryView,
  type RosterIdentityInput,
  type RosterMatchView,
  type RosterSearchInput,
  type RosterSearchView,
  type RosterSelectionInput,
} from "../../shared/roster";
import {
  CLASS_TYPES,
  parseClass,
  registrationPhone,
  phoneIdentity,
  type ClassType,
} from "../../shared/registration";
import { DomainError } from "./engine";

export type RosterMatchAggregate = {
  event: EventInfo;
  guests: readonly Guest[];
  tables: readonly EventTable[];
};

export type RosterClaimOptions = {
  confirmedGuestId: string;
  /** Server-derived claim owner, never an identity supplied by the claimant. */
  actorScope: string;
  now: string | Date;
};

// Deliberately indistinguishable: never disclose candidates, contact data,
// ownership, blocked aliases or why a particular identity could not be matched.
function rejectMatch(): never {
  throw new DomainError(
    400,
    "ROSTER_MATCH_FAILED",
    "未能核對預排名單，請向現場工作人員查詢。"
  );
}

function assertEnabled(aggregate: RosterMatchAggregate): void {
  const { event } = aggregate;
  if (
    event.mode !== "attendance" ||
    event.rosterClaimEnabled !== true ||
    event.registrationOpen !== true ||
    event.status === "closed"
  ) {
    rejectMatch();
  }
}

/** Only these explicit aliases are interchangeable; no fuzzy or prefix match. */
export function identityName(value: unknown): string {
  return normalizedRosterText(value);
}

function classType(value: unknown): ClassType | "" {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string") rejectMatch();
  const normal = value.normalize("NFKC").trim().toUpperCase();
  if (!normal) return "";
  if (!CLASS_TYPES.includes(normal as ClassType)) rejectMatch();
  return normal as ClassType;
}

function classNumber(value: unknown, type: ClassType | ""): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string") rejectMatch();
  const normal = value.normalize("NFKC").trim();
  if (!normal) return "";
  if (type) {
    try {
      return parseClass(type, normal).classNumber;
    } catch {
      rejectMatch();
    }
  }
  // A legacy source may have only a number. Never infer its type from text.
  if (!/^\d{1,4}$/.test(normal) || Number(normal) < 1) rejectMatch();
  return String(Number(normal));
}

function savedPhoneIdentity(value: string): string {
  return phoneIdentity(value.normalize("NFKC").trim());
}

function parseIdentity(input: RosterIdentityInput) {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.name !== "string" ||
    typeof input.chapter !== "string" ||
    typeof input.invitedBy !== "string"
  ) {
    rejectMatch();
  }
  const name = identityName(input.name);
  const chapter = normalizedRosterText(input.chapter);
  if (!name || !chapter) rejectMatch();
  const type = classType(input.classType);
  const number = classNumber(input.classNumber, type);
  // New data must be a complete, valid pair (legacy sources may be partial).
  if (Boolean(type) !== Boolean(number)) rejectMatch();
  let phone: string;
  try {
    phone = registrationPhone(input.phone);
  } catch {
    rejectMatch();
  }
  return {
    name,
    chapter,
    invitedBy: identityName(input.invitedBy),
    classType: type,
    classNumber: number,
    phone,
  };
}

function inEvent(aggregate: RosterMatchAggregate, guest: Guest): boolean {
  return (
    guest.eventId === aggregate.event.id &&
    guest.tenantId === aggregate.event.tenantId &&
    !isExcludedFromEvent(aggregate.event, guest)
  );
}

function arrangedTable(
  aggregate: RosterMatchAggregate,
  guest: Guest
): EventTable {
  if (
    !inEvent(aggregate, guest) ||
    !normalizedRosterText(guest.rosterKey) ||
    guest.rosterClaimBlocked ||
    !guest.tableId ||
    !Number.isInteger(guest.seat) ||
    guest.seat === null ||
    guest.seat < 1 ||
    guest.seat > 12 ||
    aggregate.guests.filter(candidate => candidate.id === guest.id).length !== 1
  ) {
    rejectMatch();
  }
  const tables = aggregate.tables.filter(
    table =>
      table.id === guest.tableId &&
      table.eventId === aggregate.event.id &&
      table.tenantId === aggregate.event.tenantId
  );
  if (tables.length !== 1) rejectMatch();
  const table = tables[0];
  if (
    !Number.isSafeInteger(table.capacity) ||
    guest.seat > table.capacity ||
    aggregate.guests.some(
      candidate =>
        candidate.id !== guest.id &&
        inEvent(aggregate, candidate) &&
        candidate.tableId === guest.tableId &&
        candidate.seat === guest.seat
    )
  ) {
    rejectMatch();
  }
  return table;
}

/**
 * Self-reported on-site roster recognition, NOT OTP identity verification.
 * Returning a Guest here does not issue any token/capability. HTTP code must
 * serialize only rosterMatchView and must never expose this internal object.
 */
export function matchRosterGuest(
  aggregate: RosterMatchAggregate,
  input: RosterIdentityInput
): Guest {
  assertEnabled(aggregate);
  const identity = parseIdentity(input);
  const namedCandidates = aggregate.guests.filter(guest => {
    if (
      !inEvent(aggregate, guest) ||
      !normalizedRosterText(guest.rosterKey) ||
      identityName(guest.name) !== identity.name ||
      normalizedRosterText(chapterOf(guest)) !== identity.chapter
    ) {
      return false;
    }
    // Malformed source class data must not accidentally select another person.
    const type = classType(guest.classType);
    const number = classNumber(guest.classNumber, type);
    return (
      (!type || type === identity.classType) &&
      (!number || number === identity.classNumber)
    );
  });
  // Missing source metadata is unknown, not a declaration of "no inviter".
  const candidates = namedCandidates.filter(guest => {
    const knownInviter = identityName(guest.invitedBy);
    return !knownInviter || knownInviter === identity.invitedBy;
  });
  // Phone, blocked status and seating never disambiguate duplicated identities.
  if (candidates.length !== 1) rejectMatch();
  const guest = candidates[0];
  // Never obtain a false unique match by guessing a missing inviter when a
  // same-name/class row exists with known metadata (even blocked/unseated).
  if (!identityName(guest.invitedBy) && namedCandidates.length !== 1) {
    rejectMatch();
  }
  arrangedTable(aggregate, guest);
  if (guest.phone.trim()) {
    if (savedPhoneIdentity(guest.phone) !== identity.phone) rejectMatch();
  } else if (
    aggregate.guests.some(
      candidate =>
        candidate.id !== guest.id &&
        inEvent(aggregate, candidate) &&
        candidate.phone.trim() &&
        savedPhoneIdentity(candidate.phone) === identity.phone
    )
  ) {
    rejectMatch();
  }
  return guest;
}

/** Allowlisted preview DTO; neither this view nor its guestId is a capability. */
export function rosterMatchView(
  aggregate: RosterMatchAggregate,
  guest: Guest
): RosterMatchView {
  assertEnabled(aggregate);
  // Accept only an actual source or an unchanged copy, never serialize an
  // arbitrary caller-supplied Guest using its ID and private contact fields.
  const source = aggregate.guests.find(candidate => candidate.id === guest.id);
  if (
    !source ||
    source.name !== guest.name ||
    source.chapter !== guest.chapter ||
    source.invitedBy !== guest.invitedBy ||
    source.classType !== guest.classType ||
    source.classNumber !== guest.classNumber ||
    source.tableId !== guest.tableId ||
    source.seat !== guest.seat
  ) {
    rejectMatch();
  }
  const table = arrangedTable(aggregate, source);
  return {
    guestId: source.id,
    name: source.name,
    chapter: chapterOf(source),
    invitedBy: source.invitedBy || "",
    classType: source.classType || "",
    classNumber: source.classNumber || "",
    table: { number: table.number, label: table.label, seat: source.seat },
  };
}

/**
 * Revalidates the entire submitted identity against the current aggregate.
 * Caller owns persistence, locking, auditing and attendance-only capabilities.
 * No receipt, ledger, draw, ticket, seat or checked-in state is modified here.
 */
export function claimRosterGuest(
  aggregate: RosterMatchAggregate,
  input: RosterIdentityInput,
  options: RosterClaimOptions
): Guest {
  const guest = matchRosterGuest(aggregate, input);
  if (
    !options ||
    typeof options.confirmedGuestId !== "string" ||
    options.confirmedGuestId !== guest.id ||
    typeof options.actorScope !== "string" ||
    !options.actorScope.trim()
  ) {
    rejectMatch();
  }
  const identity = parseIdentity(input);
  if (guest.rosterClaimedBy || guest.rosterClaimedAt) {
    if (
      guest.rosterClaimedBy !== options.actorScope ||
      !guest.rosterClaimedAt ||
      savedPhoneIdentity(guest.phone) !== identity.phone ||
      (!identityName(guest.invitedBy) && identity.invitedBy) ||
      (!classType(guest.classType) && identity.classType) ||
      (!classNumber(guest.classNumber, classType(guest.classType)) &&
        identity.classNumber)
    ) {
      rejectMatch();
    }
    // Idempotent replay: do not change original contact, metadata or timestamp.
    return { ...guest };
  }
  let claimedAt: string;
  try {
    if (typeof options.now !== "string" && !(options.now instanceof Date)) {
      rejectMatch();
    }
    const date =
      options.now instanceof Date ? options.now : new Date(options.now);
    claimedAt = date.toISOString();
  } catch {
    rejectMatch();
  }
  const claimed: Guest = {
    ...guest,
    rosterClaimedAt: claimedAt,
    rosterClaimedBy: options.actorScope,
  };
  if (!guest.phone.trim()) claimed.phone = identity.phone;
  if (!identityName(guest.invitedBy) && identity.invitedBy) {
    claimed.invitedBy = input.invitedBy
      .normalize("NFKC")
      .trim()
      .replace(/\s+/gu, " ");
  }
  if (!classType(guest.classType) && identity.classType) {
    claimed.classType = identity.classType;
  }
  if (
    !classNumber(guest.classNumber, classType(guest.classType)) &&
    identity.classNumber
  ) {
    claimed.classNumber = identity.classNumber;
  }
  return claimed;
}

// These bounds apply only to the optional-field selection flow. The legacy
// complete-identity matcher intentionally retains its existing strict contract.
function searchText(value: unknown, max = 120): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) rejectMatch();
  const text = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (text.length > max) rejectMatch();
  return text;
}

function parseSearch(input: RosterSearchInput) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.name !== "string"
  ) {
    rejectMatch();
  }
  const name = identityName(searchText(input.name));
  if (!name) rejectMatch();
  const reportedChapter = searchText(input.chapter);
  const chapter = normalizedRosterText(reportedChapter);
  const invitedBy = searchText(input.invitedBy);
  const type = classType(searchText(input.classType, 32));
  const number = classNumber(searchText(input.classNumber, 32), type);
  return {
    name,
    reportedChapter,
    chapter: chapter === normalizedRosterText(NO_CHAPTER) ? "" : chapter,
    invitedBy: identityName(invitedBy),
    reportedInviter: invitedBy,
    classType: type,
    classNumber: number,
  };
}

type ParsedRosterSearch = ReturnType<typeof parseSearch>;

/**
 * A selected ID never supplies identity or eligibility. The only claimed row
 * admitted internally is the selected row owned by the server-derived actor;
 * public searches never receive this replay exception.
 */
function selectedRosterCandidates(
  aggregate: RosterMatchAggregate,
  identity: ParsedRosterSearch,
  replay?: Pick<RosterClaimOptions, "confirmedGuestId" | "actorScope">
): Guest[] {
  const candidates: Guest[] = [];
  for (const guest of aggregate.guests) {
    if (
      !inEvent(aggregate, guest) ||
      !normalizedRosterText(guest.rosterKey) ||
      identityName(guest.name) !== identity.name
    ) {
      continue;
    }
    // Do not silently discard malformed same-name source class data and then
    // manufacture a unique candidate from a different row.
    const type = classType(guest.classType);
    const number = classNumber(guest.classNumber, type);
    const knownChapter = normalizedRosterText(chapterOf(guest));
    const knownInviter = identityName(guest.invitedBy);
    if (
      (identity.chapter && knownChapter && identity.chapter !== knownChapter) ||
      (identity.invitedBy &&
        knownInviter &&
        identity.invitedBy !== knownInviter) ||
      (identity.classType && type && identity.classType !== type) ||
      (identity.classNumber && number && identity.classNumber !== number) ||
      guest.rosterClaimBlocked ||
      ((guest.rosterClaimedAt || guest.rosterClaimedBy) &&
        !(
          replay &&
          guest.id === replay.confirmedGuestId &&
          guest.rosterClaimedBy === replay.actorScope &&
          guest.rosterClaimedAt
        ))
    ) {
      continue;
    }
    // A source key collision is not two independent source rows, even when
    // their guest IDs and seats happen to differ. Ignore retained exclusions.
    if (
      aggregate.guests.some(
        other =>
          other !== guest &&
          inEvent(aggregate, other) &&
          normalizedRosterText(other.rosterKey) ===
            normalizedRosterText(guest.rosterKey)
      )
    ) {
      continue;
    }
    try {
      arrangedTable(aggregate, guest);
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "ROSTER_MATCH_FAILED"
      ) {
        continue;
      }
      throw error;
    }
    candidates.push(guest);
  }
  return candidates;
}

/** Bounded, allowlisted candidates, not an identity proof or claim capability. */
export function searchRosterGuests(
  aggregate: RosterMatchAggregate,
  input: RosterSearchInput
): RosterSearchView {
  assertEnabled(aggregate);
  const candidates = selectedRosterCandidates(aggregate, parseSearch(input));
  if (candidates.length > ROSTER_CANDIDATE_LIMIT) {
    return { candidates: [], requiresRefinement: true };
  }
  return {
    candidates: candidates.map(guest => rosterMatchView(aggregate, guest)),
    requiresRefinement: false,
  };
}

/**
 * Explicitly consent-gated fallback list for the public ceremony registration page.
 * It reveals active guest display names only: no IDs, ticket, contact, seating,
 * chapter, inviter, claim state, notes or staff grouping. The list is not a claim
 * capability; the visitor must still run roster search and confirm by phone.
 */
export function listRosterGuestNames(
  aggregate: RosterMatchAggregate,
  sort: "name" | "phone" = "name"
): RosterNameDirectoryView {
  assertEnabled(aggregate);
  const names = new Map<string, { name: string; phone: string; index: number }>();
  let index = 0;
  for (const guest of aggregate.guests) {
    if (!inEvent(aggregate, guest) || typeof guest.name !== "string") continue;
    const name = guest.name.trim();
    const key = normalizedRosterText(name);
    if (!name || name.length > 120 || !key || names.has(key)) continue;
    let phone = "";
    try {
      if (guest.phone.trim()) phone = registrationPhone(guest.phone);
    } catch {
      // Malformed legacy phones behave like an empty phone for ordering only.
    }
    names.set(key, { name, phone, index });
    index += 1;
  }
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

/**
 * Re-run the current bounded candidate search before accepting the selected ID.
 * Caller owns locking/persistence and must derive actorScope on the server.
 * Only first confirmation can supplement metadata; seating and identity stay
 * exactly as arranged. No wall clock or caller token is consulted here.
 */
export function claimRosterSelectedGuest(
  aggregate: RosterMatchAggregate,
  input: RosterSelectionInput,
  options: RosterClaimOptions
): Guest {
  assertEnabled(aggregate);
  const identity = parseSearch(input);
  if (
    !options ||
    typeof options.confirmedGuestId !== "string" ||
    !options.confirmedGuestId.trim() ||
    options.confirmedGuestId.length > 80 ||
    typeof options.actorScope !== "string" ||
    !options.actorScope.trim()
  ) {
    rejectMatch();
  }
  let phone: string;
  try {
    phone = registrationPhone(searchText(input.phone, 80));
  } catch {
    rejectMatch();
  }
  const candidates = selectedRosterCandidates(aggregate, identity, options);
  if (candidates.length > ROSTER_CANDIDATE_LIMIT) rejectMatch();
  const guest = candidates.find(item => item.id === options.confirmedGuestId);
  if (!guest || typeof guest.phone !== "string") rejectMatch();
  // Keep the established known-phone consistency / unknown-phone active
  // deduplication rule, including the attendance exclusion exception.
  if (guest.phone.trim()) {
    if (savedPhoneIdentity(guest.phone) !== phone) rejectMatch();
  } else if (
    aggregate.guests.some(
      other =>
        other.id !== guest.id &&
        inEvent(aggregate, other) &&
        other.phone.trim() &&
        savedPhoneIdentity(other.phone) === phone
    )
  ) {
    rejectMatch();
  }
  const knownType = classType(guest.classType);
  const knownNumber = classNumber(guest.classNumber, knownType);
  const completeClass = Boolean(identity.classType && identity.classNumber);
  if (guest.rosterClaimedBy || guest.rosterClaimedAt) {
    if (
      guest.rosterClaimedBy !== options.actorScope ||
      !guest.rosterClaimedAt ||
      savedPhoneIdentity(guest.phone) !== phone ||
      (!identityName(guest.invitedBy) && identity.invitedBy) ||
      (completeClass && (!knownType || !knownNumber)) ||
      (identity.reportedChapter &&
        normalizedRosterText(guest.reportedChapter) !==
          normalizedRosterText(identity.reportedChapter))
    ) {
      rejectMatch();
    }
    // Even an equivalent replay after many hours does not rewrite data/time.
    return { ...guest };
  }
  let claimedAt: string;
  try {
    if (typeof options.now !== "string" && !(options.now instanceof Date)) {
      rejectMatch();
    }
    const date =
      options.now instanceof Date ? options.now : new Date(options.now);
    claimedAt = date.toISOString();
  } catch {
    rejectMatch();
  }
  const claimed: Guest = {
    ...guest,
    rosterClaimedAt: claimedAt,
    rosterClaimedBy: options.actorScope,
  };
  if (!guest.phone.trim()) claimed.phone = phone;
  if (!identityName(guest.invitedBy) && identity.invitedBy) {
    claimed.invitedBy = identity.reportedInviter;
  }
  // Never write an incomplete pair, and never overwrite known source fields.
  if (completeClass) {
    if (!knownType) claimed.classType = identity.classType;
    if (!knownNumber) claimed.classNumber = identity.classNumber;
  }
  if (identity.reportedChapter)
    claimed.reportedChapter = identity.reportedChapter;
  return claimed;
}
