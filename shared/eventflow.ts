export type Role =
  | "owner"
  | "admin"
  | "project_manager"
  | "guest_manager"
  | "checkin"
  | "draw"
  | "merchant";
export type EventMode = "full" | "attendance";

/** Fixed identity and Hong Kong instant for the one-off on-site red-packet draw. */
export const POSITIVE_SPRING_EVENT_ID = "a6627e4a-0492-4c0a-b6a3-8bb11cb197fb";
export const POSITIVE_SPRING_RED_PACKET_KEY =
  "positive-spring-2027-red-packet-hkd1000-v1";
/** Fixed server-owned prize identity; ordinary prize creation must never claim it. */
export const POSITIVE_SPRING_RESERVED_PRIZE_ID =
  "6f5b7d2e-1c44-4e9a-9f3b-2c7d8a1e5b60";
export const POSITIVE_SPRING_DRAW_AT = "2027-01-31T09:00:00.000Z";

export type Brand = {
  name: string;
  color: string;
  logoUrl: string;
  privacyText: string;
};

/** Extra programme details are optional for a regular event and used by attendance ceremonies. */
export type EventProgram = {
  titleEn: string;
  organizationEn: string;
  venueAddress: string;
  receptionTime: string;
  seatingTime: string;
};

export type EventInfo = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  /** YYYY-MM-DD means the time is undecided; an ISO datetime is a specific instant. */
  date: string;
  /** Empty string means the venue has not been decided. */
  venue: string;
  status: "draft" | "live" | "closed";
  /** attendance hides and disables merchant, consumption and draw operations. */
  mode: EventMode;
  program: EventProgram;
  brand: Brand;
  registrationOpen: boolean;
  /** Self-reported on-site attendance; never validates a guest's physical location. */
  registrationCheckIn?: boolean;
  /** Attendance-only recognition of pre-arranged guests; not an OTP identity proof. */
  rosterClaimEnabled?: boolean;
  /** Chapter names only; never a public guest or inviter directory. */
  rosterChapters?: string[];
  thresholdCents: number;
  accumulation: "per_transaction" | "cumulative";
  ruleVersion: number;
  excludeWinners: boolean;
};

export type Guest = {
  id: string;
  tenantId: string;
  eventId: string;
  name: string;
  email: string;
  phone: string;
  classType?: import("./registration").ClassType | "";
  classNumber?: string;
  chapter?: string;
  /** Optional participant self-report, separate from the organiser's seating chapter. */
  reportedChapter?: string;
  invitedBy?: string;
  memberKind?: import("./roster").MemberKind;
  rosterKey?: string;
  rosterClaimBlocked?: boolean;
  /** Retained, non-participating record. Effective ONLY in attendance mode. */
  excludedFromEvent?: boolean;
  rosterClaimedAt?: string | null;
  /** Internal claim owner; never included in public match responses. */
  rosterClaimedBy?: string;
  /** Private staff-only grouping, for example a chapter or host team. */
  group: string;
  /** Private staff-only note. It is never added to the public event listing. */
  note: string;
  ticket: string;
  /**
   * Membership code shown as the guest's personal QR (for example BP54). Unique
   * within an event; derived from the ticket when the organiser has not set one.
   */
  memberCode?: string;
  checkedInAt: string | null;
  tableId: string | null;
  seat: number | null;
  chances: number;
  createdAt: string;
};

export const MEMBER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

/** Upper-case, trimmed; returns null when the value is not a usable code. */
export function normalizeMemberCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return MEMBER_CODE_PATTERN.test(code) ? code : null;
}

/** Every guest has a code: the organiser's own or M + ticket number. */
export function memberCodeOf(guest: Pick<Guest, "memberCode" | "ticket">) {
  return guest.memberCode || `M${guest.ticket}`;
}

export function isExcludedFromEvent(
  event: Pick<EventInfo, "mode">,
  guest: Pick<Guest, "excludedFromEvent">
): boolean {
  return event.mode === "attendance" && guest.excludedFromEvent === true;
}

export function eventGuests(
  event: Pick<EventInfo, "mode">,
  guests: readonly Guest[]
): Guest[] {
  return guests.filter(guest => !isExcludedFromEvent(event, guest));
}

export type EventTable = {
  id: string;
  tenantId: string;
  eventId: string;
  number: number;
  label: string;
  capacity: number;
  x: number;
  y: number;
};

export type Merchant = {
  id: string;
  tenantId: string;
  eventId: string;
  name: string;
  active: boolean;
  createdAt: string;
};

export type Receipt = {
  id: string;
  tenantId: string;
  eventId: string;
  merchantId: string;
  amountCents: number;
  feeCents: number;
  status: "valid" | "void" | "pending" | "rejected";
  intendedGuestId?: string;
  confirmationRequired?: boolean;
  merchantName?: string;
  decisionAt?: string;
  guestId: string | null;
  claimedAt: string | null;
  createdAt: string;
  expiresAt: string;
  reference: string;
  ruleVersion: number;
  thresholdCents: number;
  accumulation: "per_transaction" | "cumulative";
  chances: number;
  voidReason?: string;
  drawException?: boolean;
};

export type Payment = {
  id: string;
  merchantId: string;
  amountCents: number;
  reference: string;
  createdAt: string;
};

/** A pre-ordered item the guest collects from a merchant at the fair. */
export type Preorder = {
  id: string;
  tenantId: string;
  eventId: string;
  guestId: string;
  merchantId: string;
  merchantName?: string;
  item: string;
  quantity: number;
  /** 0 when the amount is unknown or already paid elsewhere. */
  amountCents: number;
  status: "pending" | "collected" | "cancelled";
  /** manual: entered on site; yeeahk: synced from the online shop later. */
  source: "manual" | "yeeahk";
  externalId?: string;
  note?: string;
  createdAt: string;
  collectedAt: string | null;
  cancelledAt?: string | null;
};

export type Prize = {
  id: string;
  name: string;
  drawId: string | null;
  /** Server-only stable identity for system-managed one-off prizes. */
  key?: string;
};

export type Draw = {
  id: string;
  prizeId: string;
  prizeName: string;
  /** Present on the one-off server-managed draw, never accepted from clients. */
  specialKey?: string;
  winner: {
    id: string;
    name: string;
    ticket: string;
    tableNumber: number | null;
  };
  totalChances: number;
  eligibleGuests: number;
  createdAt: string;
  revealedAt: string | null;
};

export type Audit = {
  id: string;
  action: string;
  actor: string;
  createdAt: string;
  detail: string;
};

export type Member = {
  id: string;
  userId: number | null;
  name: string;
  role: Role;
  merchantId: string | null;
  inviteExpiresAt?: string;
  active: boolean;
};

export type WorkspaceState = {
  event: EventInfo;
  role: Role;
  guests: Guest[];
  tables: EventTable[];
  merchants: Merchant[];
  receipts: Receipt[];
  payments: Payment[];
  prizes: Prize[];
  draws: Draw[];
  members: Member[];
  audit: Audit[];
  preorders?: Preorder[];
};

export type Session = {
  user: {
    id: number;
    name: string | null;
    email: string | null;
    systemRole: "owner" | "admin" | "user";
    provider: "google" | "manus" | "local";
  };
  canCreateEvents: boolean;
  canManageAccess: boolean;
  organizations: { id: string; name: string }[];
  events: (EventInfo & { role: Role })[];
};

export type GuestView = {
  event: Omit<EventInfo, "tenantId">;
  guest: Guest;
  table: { number: number; label: string; seat: number | null } | null;
  receipts: Receipt[];
  draws: Draw[];
  preorders?: Preorder[];
};

export type ReceiptIssued = {
  receipt: Receipt;
  token?: string;
  path?: string;
  possibleChances: number;
};

export type PurchaseCodeIssued = {
  code: string;
  path: string;
  expiresAt: string;
};
export type PurchaseCodeResolved = {
  guest: Pick<Guest, "id" | "name" | "ticket"> & { memberCode: string };
  expiresAt: string;
  /** member_code: resolved from the guest's membership QR or typed code. */
  method: "purchase_code" | "member_code";
  /** Uncollected pre-orders for the resolving merchant only. */
  preorders: Preorder[];
};
export type ClaimPreview = { receipt: Receipt; merchantName: string };

export type Invitation = { token: string; path: string; expiresAt?: string };

export type ClaimResult = {
  receipt: Receipt;
  gained: number;
  total: number;
  alreadyClaimed: boolean;
};

export type Settlement = {
  merchant: Merchant;
  salesCents: number;
  dueCents: number;
  paidCents: number;
  balanceCents: number;
};

export type AccessUser = {
  id: number;
  name: string | null;
  email: string | null;
  /** Google sign-in or an admin-created username/password account. */
  provider?: "google" | "local";
  systemRole: "owner" | "admin" | "user";
  assignments: {
    memberId: string;
    eventId: string;
    role: Role;
    merchantId: string | null;
    active: boolean;
  }[];
};
export type AccessDirectory = {
  users: AccessUser[];
  events: {
    id: string;
    name: string;
    mode: EventMode;
    merchants: { id: string; name: string }[];
  }[];
  canGrantSystemAdmin: boolean;
};
