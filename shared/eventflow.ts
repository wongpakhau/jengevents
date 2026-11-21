export type Role =
  | "owner"
  | "admin"
  | "project_manager"
  | "guest_manager"
  | "checkin"
  | "draw"
  | "merchant";
export type EventMode = "full" | "attendance";

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
  checkedInAt: string | null;
  tableId: string | null;
  seat: number | null;
  chances: number;
  createdAt: string;
};

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
  status: "valid" | "void";
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

export type Prize = { id: string; name: string; drawId: string | null };

export type Draw = {
  id: string;
  prizeId: string;
  prizeName: string;
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
};

export type Session = {
  user: {
    id: number;
    name: string | null;
    email: string | null;
    systemRole: "owner" | "admin" | "user";
    provider: "google" | "manus";
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
};

export type ReceiptIssued = {
  receipt: Receipt;
  token: string;
  path: string;
  possibleChances: number;
};

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
