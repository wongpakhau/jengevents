import { randomInt, randomUUID } from "node:crypto";
import { Router, type Express, type Request, type Response } from "express";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type {
  Audit,
  Draw,
  EventInfo,
  EventTable,
  Guest,
  Invitation,
  Member,
  Merchant,
  Payment,
  Prize,
  Receipt,
  Session,
  WorkspaceState,
} from "../../shared/eventflow";
import { eventGuests, isExcludedFromEvent } from "../../shared/eventflow";
import { normalizeEventDate } from "../../shared/event-date";
import { validLogoAddress } from "../../shared/brand";
import {
  classLabel,
  parseClass,
  phoneIdentity,
  registrationPhone,
} from "../../shared/registration";
import { merchantSettlement, accountingCsv } from "./accounting";
import { guestRosterCsv } from "./roster";
import { validateRosterFields, guestSelfView, type RosterFields } from "./roster-fields";
import { quickGuestNames, quickGuestSearch, claimQuickGuest, assertQuickNameIsNew } from "./quick-registration";
import { matchRosterGuest, rosterMatchView, claimRosterGuest, searchRosterGuests, claimRosterSelectedGuest, listRosterGuestNames } from "./roster-match";
import { CHAPTERS, type RosterIdentityInput, type RosterSearchInput, type RosterSelectionInput } from "../../shared/roster";
import { planSeatingImport, type SeatingImportRow } from "./seating-import";
import { availableChances } from "./engine";
import { SESSION_EVENTS_SQL } from "./session-query";
import { systemRoleFor, accessDirectory } from "./system-access";
import { isSystemOwner } from "./access-policy";
import { emptyProgram, slugFor, defaultEvent, newAggregate } from "./event-defaults";
import { listPendingOwnership, claimPendingOwnership } from "./pending-ownership";
import { HttpError } from "../../shared/_core/errors";
import { sdk, type AuthenticatedUser } from "../_core/sdk";
import { readParticipantSession } from "../_core/participantAuth";
import {
  lockedEventRow,
  readRows,
  withTransaction,
  type EventRow,
} from "./database";
import {
  DomainError,
  assertEventScope,
  assertSeatChange,
  buildDrawSnapshot,
  cumulativeClaimDelta,
  feeForCents,
  getLedgerBalance,
  integerCents,
  publicEventInfo,
  receiptChances,
  receiptInAnyDrawSnapshot,
  recalculateGuestChances,
  selectWeightedWinner,
  voidLedgerAdjustment,
  type EventAggregate,
  type InternalDraw,
  type LedgerEntry,
} from "./engine";
import {
  assertRateLimit,
  assertSameOriginJson,
  decryptSensitiveJson,
  encryptSensitiveJson,
  newCapabilityToken,
  requestHash,
  requireIdempotencyKey,
  sha256,
} from "./security";

type MemberRow = RowDataPacket & {
  id: string;
  event_id: string;
  user_id: number;
  name: string;
  role:
    | "admin"
    | "project_manager"
    | "guest_manager"
    | "checkin"
    | "draw"
    | "merchant";
  merchant_id: string | null;
  active: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type InviteRow = RowDataPacket & {
  id: string;
  event_id: string;
  kind: "staff" | "guest" | "receipt";
  token_hash: string;
  guest_id: string | null;
  role:
    | "admin"
    | "project_manager"
    | "guest_manager"
    | "checkin"
    | "draw"
    | "merchant"
    | null;
  merchant_id: string | null;
  name: string | null;
  version: number;
  expires_at: Date | string | null;
  consumed_by_user_id: number | null;
  claimed_by_guest_id: string | null;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
};

type IdempotencyRow = RowDataPacket & {
  request_hash: string;
  response_ciphertext: string;
};

type OrganizationRow = RowDataPacket & {
  id: string;
  name: string;
  owner_user_id: number | null;
};
type PublicEventRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  owner_user_id: number | null;
  event_state: string;
};

type Access = {
  role:
    | "owner"
    | "admin"
    | "project_manager"
    | "guest_manager"
    | "checkin"
    | "draw"
    | "merchant";
  merchantId: string | null;
};

type LockedContext = {
  connection: PoolConnection;
  row: EventRow;
  aggregate: EventAggregate;
  access: Access;
  now: Date;
};

const STAFF_ROLES = [
  "admin",
  "project_manager",
  "guest_manager",
  "checkin",
  "draw",
  "merchant",
] as const;
const MAX_GUESTS_IMPORT = 500;
const MAX_SEATING_IMPORT = 500;
const MAX_TEXT = 4_000;

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function sqlDate(now: Date): string {
  return now.toISOString().slice(0, 23).replace("T", " ").replace("Z", "");
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function bodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new DomainError(400, "INVALID_BODY", "請求內容格式不正確");
  }
  return req.body as Record<string, unknown>;
}

function text(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; optional?: boolean } = {}
): string | undefined {
  if (value === undefined || value === null) {
    if (options.optional) return undefined;
    throw new DomainError(400, "VALIDATION_ERROR", `請提供${label}`);
  }
  if (typeof value !== "string")
    throw new DomainError(400, "VALIDATION_ERROR", `${label}格式不正確`);
  const normalized = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 200;
  if (normalized.length < min || normalized.length > max) {
    throw new DomainError(400, "VALIDATION_ERROR", `${label}長度不正確`);
  }
  return normalized;
}

function optionalContact(value: unknown, label: "電郵" | "電話"): string {
  if (value === undefined || value === null || value === "") return "";
  const normalized = text(value, label, { max: label === "電郵" ? 320 : 40 })!;
  if (label === "電郵" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new DomainError(400, "INVALID_EMAIL", "電郵格式不正確");
  }
  if (label === "電話" && !/^[+()\-\s0-9]{6,40}$/u.test(normalized)) {
    throw new DomainError(400, "INVALID_PHONE", "電話格式不正確");
  }
  return normalized;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new DomainError(400, "VALIDATION_ERROR", `${label}必須為布林值`);
  return value;
}

function finiteNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer = false
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new DomainError(400, "VALIDATION_ERROR", `${label}格式不正確`);
  }
  return value;
}

function requireIsoDate(value: unknown, label = "日期"): string {
  const source = text(value, label, { max: 64 })!;
  const normalized = normalizeEventDate(source);
  if (!normalized)
    throw new DomainError(
      400,
      "INVALID_DATE",
      `${label}必須為有效的 ISO 日期；指定時間時須包含 Z 或 UTC 時區偏移`
    );
  return normalized;
}

function eventMode(value: unknown): EventInfo["mode"] {
  if (value === undefined) return "full";
  if (value === "full" || value === "attendance") return value;
  throw new DomainError(400, "VALIDATION_ERROR", "活動模式不正確");
}

function validateProgram(value: unknown): EventInfo["program"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(400, "VALIDATION_ERROR", "典禮資料格式不正確");
  }
  const program = value as Record<string, unknown>;
  return {
    titleEn:
      text(program.titleEn, "英文活動名稱", {
        optional: true,
        min: 0,
        max: 200,
      }) ?? "",
    organizationEn:
      text(program.organizationEn, "英文組織名稱", {
        optional: true,
        min: 0,
        max: 200,
      }) ?? "",
    venueAddress:
      text(program.venueAddress, "場地地址", {
        optional: true,
        min: 0,
        max: 400,
      }) ?? "",
    receptionTime:
      text(program.receptionTime, "恭候時間", {
        optional: true,
        min: 0,
        max: 80,
      }) ?? "",
    seatingTime:
      text(program.seatingTime, "入席時間", {
        optional: true,
        min: 0,
        max: 80,
      }) ?? "",
  };
}

function assertFeatureEnabled(
  event: EventInfo,
  feature: "commerce" | "draw"
): void {
  if (event.mode === "attendance") {
    throw new DomainError(
      409,
      "FEATURE_DISABLED",
      feature === "commerce"
        ? "此簽到典禮未啟用商戶、消費或對帳功能"
        : "此簽到典禮未啟用抽獎功能"
    );
  }
}

function parseAggregate(raw: string): EventAggregate {
  try {
    const parsed = JSON.parse(raw) as EventAggregate;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.event ||
      !Array.isArray(parsed.guests) ||
      !Array.isArray(parsed.ledger)
    ) {
      throw new Error("invalid aggregate");
    }
    parsed.tables ??= [];
    parsed.merchants ??= [];
    parsed.receipts ??= [];
    parsed.payments ??= [];
    parsed.prizes ??= [];
    parsed.draws ??= [];
    parsed.audit ??= [];
    // JSON aggregates from earlier MVP versions did not have ceremony-only fields.
    parsed.event.mode ??= "full";
    parsed.event.program ??= emptyProgram();
    parsed.event.registrationCheckIn ??= false;
    parsed.event.rosterClaimEnabled ??= false;
    parsed.event.rosterChapters ??= [];
    if (parsed.event.mode !== "attendance") parsed.event.rosterClaimEnabled = false;
    for (const guest of parsed.guests) {
      guest.group ??= "";
      guest.note ??= "";
      guest.classType ??= "";
      guest.classNumber ??= "";
    }
    return parsed;
  } catch {
    throw new DomainError(
      503,
      "EVENT_STATE_UNAVAILABLE",
      "活動資料暫時無法安全讀取"
    );
  }
}

function quickAggregate(row: PublicEventRow): EventAggregate {
  // Preserve absent-field legacy defaults, but never reinterpret explicit
  // malformed history as empty before the quick identity safety check.
  let raw: EventAggregate;
  try { raw = JSON.parse(row.event_state); }
  catch { throw new DomainError(503, "EVENT_STATE_UNAVAILABLE", "活動資料暫時無法安全讀取"); }
  if (!raw?.event || (raw.event.mode !== "attendance" &&
    ["receipts", "draws", "ledger"].some(field =>
      Object.prototype.hasOwnProperty.call(raw, field) && !Array.isArray(raw[field as keyof EventAggregate]))))
    throw new DomainError(503, "EVENT_STATE_UNAVAILABLE", "活動資料暫時無法安全讀取");
  const aggregate = parseAggregate(row.event_state);
  if (aggregate.event.id !== row.id || aggregate.event.tenantId !== row.tenant_id)
    throw new DomainError(503, "EVENT_STATE_UNAVAILABLE", "活動資料暫時無法安全讀取");
  return aggregate;
}

function addAudit(
  aggregate: EventAggregate,
  action: string,
  actor: string,
  detail: string,
  now: Date
): void {
  const audit: Audit = {
    id: randomUUID(),
    action,
    actor,
    createdAt: nowIso(now),
    detail,
  };
  aggregate.audit.push(audit);
}

function updateGuestChances(aggregate: EventAggregate, guestId: string): Guest {
  const index = aggregate.guests.findIndex(guest => guest.id === guestId);
  if (index < 0) throw new DomainError(404, "GUEST_NOT_FOUND", "找不到嘉賓");
  const updated = recalculateGuestChances(
    aggregate.guests[index],
    aggregate.ledger
  );
  aggregate.guests[index] = updated;
  return updated;
}

function publicGuest(guest: Guest): Omit<Guest, "email" | "phone"> {
  const { email: _email, phone: _phone, ...safe } = guest;
  return safe;
}

function drawDto(draw: InternalDraw): Draw {
  const { winnerGuestId: _winnerGuestId, snapshot: _snapshot, ...safe } = draw;
  return safe;
}

function basicEvent(event: EventInfo): Omit<EventInfo, "tenantId"> {
  return publicEventInfo(event);
}

function memberDto(row: MemberRow): Member {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    role: row.role,
    merchantId: row.merchant_id,
    active: Boolean(row.active),
  };
}

function assertNoCron(user: AuthenticatedUser): void {
  if (user.isCron)
    throw new DomainError(403, "CRON_FORBIDDEN", "排程身份不可操作活動資料");
}

async function authenticated(req: Request): Promise<AuthenticatedUser> {
  try {
    const user = await sdk.authenticateRequest(req);
    assertNoCron(user);
    return user;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(401, "UNAUTHORIZED", "請先登入");
  }
}

async function authenticatedMutation(req: Request): Promise<AuthenticatedUser> {
  assertSameOriginJson(req);
  return authenticated(req);
}

async function accessFor(
  connection: PoolConnection,
  row: Pick<EventRow, "id" | "owner_user_id">,
  user: AuthenticatedUser
): Promise<Access | null> {
  if (row.owner_user_id == null) return null;
  const globalRole = await systemRoleFor(user, connection);
  if (globalRole !== "user") return { role: globalRole, merchantId: null };
  const userId = user.id;
  if (row.owner_user_id === userId) return { role: "owner", merchantId: null };
  const [members] = await connection.query<MemberRow[]>(
    "SELECT id,event_id,user_id,name,role,merchant_id,active,created_at,updated_at FROM ef_members WHERE event_id = ? AND user_id = ? AND active = 1 LIMIT 1",
    [row.id, userId]
  );
  const member = members[0];
  return member ? { role: member.role, merchantId: member.merchant_id } : null;
}

function requireRole(
  access: Access | null,
  allowed: readonly Access["role"][]
): Access {
  if (!access || !allowed.includes(access.role)) {
    throw new DomainError(403, "FORBIDDEN", "你沒有此活動的操作權限");
  }
  return access;
}

async function saveAggregate(
  connection: PoolConnection,
  eventId: string,
  aggregate: EventAggregate,
  now: Date
): Promise<void> {
  await connection.execute(
    "UPDATE ef_events SET event_state = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify(aggregate), sqlDate(now), eventId]
  );
}

async function listMembers(
  connection: PoolConnection,
  eventId: string
): Promise<Member[]> {
  const [rows] = await connection.query<MemberRow[]>(
    "SELECT id,event_id,user_id,name,role,merchant_id,active,created_at,updated_at FROM ef_members WHERE event_id = ? ORDER BY created_at ASC",
    [eventId]
  );
  return rows.map(memberDto);
}

async function replayOrStore<T>(
  connection: PoolConnection,
  input: {
    eventId: string;
    action: string;
    actorScope: string;
    key: string;
    body: unknown;
    now: Date;
  },
  create: () => Promise<T>
): Promise<T> {
  const [rows] = await connection.query<IdempotencyRow[]>(
    "SELECT request_hash,response_ciphertext FROM ef_idempotency WHERE event_id = ? AND action = ? AND actor_scope = ? AND idempotency_key = ? FOR UPDATE",
    [input.eventId, input.action, input.actorScope, input.key]
  );
  const hash = requestHash(input.body);
  const existing = rows[0];
  if (existing) {
    if (existing.request_hash !== hash) {
      throw new DomainError(
        409,
        "IDEMPOTENCY_MISMATCH",
        "相同冪等鍵不能用於不同請求"
      );
    }
    return decryptSensitiveJson<T>(existing.response_ciphertext);
  }
  const response = await create();
  await connection.execute(
    "INSERT INTO ef_idempotency (id,event_id,action,actor_scope,idempotency_key,request_hash,response_ciphertext,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      input.eventId,
      input.action,
      input.actorScope,
      input.key,
      hash,
      encryptSensitiveJson(response),
      sqlDate(input.now),
    ]
  );
  return response;
}

async function withLockedStaffEvent<T>(
  req: Request,
  user: AuthenticatedUser,
  eventId: string,
  action: string,
  allowed: readonly Access["role"][],
  work: (context: LockedContext) => Promise<T>,
  options: { idempotent?: boolean } = {}
): Promise<T> {
  const key =
    options.idempotent === false ? undefined : requireIdempotencyKey(req);
  return withTransaction(async connection => {
    const row = await lockedEventRow(connection, eventId);
    assertBoundEvent(row);
    const aggregate = parseAggregate(row.event_state);
    const access = requireRole(await accessFor(connection, row, user), allowed);
    const now = new Date();
    const context: LockedContext = { connection, row, aggregate, access, now };
    if (!key) {
      const response = await work(context);
      await saveAggregate(connection, row.id, aggregate, now);
      return response;
    }
    return replayOrStore(
      connection,
      {
        eventId: row.id,
        action,
        actorScope: `user:${user.id}`,
        key,
        body: bodyObject(req),
        now,
      },
      async () => {
        const response = await work(context);
        await saveAggregate(connection, row.id, aggregate, now);
        return response;
      }
    );
  });
}

function invitation(
  raw: string,
  kind: "staff" | "guest",
  expiresAt?: string
): Invitation {
  return {
    token: raw,
    path: kind === "staff" ? `/join#invite=${raw}` : `/guest#invite=${raw}`,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

async function insertInvite(
  connection: PoolConnection,
  input: {
    eventId: string;
    kind: "staff" | "guest" | "receipt";
    guestId?: string | null;
    role?:
      | "admin"
      | "project_manager"
      | "guest_manager"
      | "checkin"
      | "draw"
      | "merchant"
      | null;
    merchantId?: string | null;
    name?: string | null;
    version?: number;
    expiresAt?: Date | null;
    now: Date;
  }
): Promise<{ token: string; expiresAt?: string }> {
  const token = newCapabilityToken();
  await connection.execute(
    "INSERT INTO ef_invites (id,event_id,kind,token_hash,guest_id,role,merchant_id,name,version,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      input.eventId,
      input.kind,
      sha256(token),
      input.guestId ?? null,
      input.role ?? null,
      input.merchantId ?? null,
      input.name ?? null,
      input.version ?? 1,
      input.expiresAt ? sqlDate(input.expiresAt) : null,
      sqlDate(input.now),
    ]
  );
  return {
    token,
    expiresAt: input.expiresAt ? nowIso(input.expiresAt) : undefined,
  };
}

function assertInviteUsable(row: InviteRow, now: Date): void {
  if (row.revoked_at || row.consumed_at)
    throw new DomainError(409, "TOKEN_USED", "此憑證已失效或已使用");
  const expiresAt = iso(row.expires_at);
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) {
    throw new DomainError(410, "TOKEN_EXPIRED", "此憑證已過期");
  }
}

function assertExclusionMode(event: EventInfo, guest: Pick<Guest, "excludedFromEvent">): void {
  if (guest.excludedFromEvent === true && event.mode !== "attendance")
    throw new DomainError(409, "ATTENDANCE_ONLY", "保留不參會只適用於典禮模式");
}

function assertParticipating(event: EventInfo, guest: Guest): void {
  if (isExcludedFromEvent(event, guest))
    throw new DomainError(409, "GUEST_EXCLUDED", "此紀錄保留但不參會，請先解除保留");
}

function assertActiveContactUnique(aggregate: EventAggregate, next: Guest | Parameters<typeof createGuest>[1]): void {
  if (isExcludedFromEvent(aggregate.event, next)) return;
  const id = "id" in next ? next.id : undefined;
  if (eventGuests(aggregate.event, aggregate.guests).some(guest =>
    guest.id !== id && ((next.email && guest.email.toLowerCase() === next.email.toLowerCase()) ||
      (next.phone && phoneIdentity(guest.phone) === phoneIdentity(next.phone)))))
    throw new DomainError(409, "DUPLICATE_GUEST", "聯絡資料已登記於活動，解除保留前須先核對");
}

function createGuest(
  aggregate: EventAggregate,
  input: {
    name: string;
    email: string;
    phone: string;
    group: string;
    note: string;
    classType?: Guest["classType"];
    classNumber?: string;
  } & RosterFields,
  now: Date
): Guest {
  if(input.rosterKey && aggregate.guests.some(g=>g.rosterKey===input.rosterKey))
    throw new DomainError(409,"ROSTER_KEY_EXISTS","此名單編號已存在，請編輯現有嘉賓");
  assertExclusionMode(aggregate.event, input);
  assertActiveContactUnique(aggregate, input);
  const tickets = new Set(aggregate.guests.map(guest => guest.ticket));
  let ticket = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    ticket = String(randomInt(1_000_000)).padStart(6, "0");
    if (!tickets.has(ticket)) break;
    ticket = "";
  }
  if (!ticket)
    throw new DomainError(
      503,
      "TICKET_UNAVAILABLE",
      "暫時無法建立票號，請稍後再試"
    );
  const guest: Guest = {
    id: randomUUID(),
    tenantId: aggregate.event.tenantId,
    eventId: aggregate.event.id,
    ...input,
    rosterKey: input.rosterKey || (input.chapter ? `manual:${randomUUID()}` : undefined),
    name: input.name,
    email: input.email,
    phone: input.phone,
    classType: input.classType || "",
    classNumber: input.classNumber || "",
    group: input.group,
    note: input.note,
    ticket,
    checkedInAt: null,
    tableId: null,
    seat: null,
    chances: 0,
    createdAt: nowIso(now),
  };
  aggregate.guests.push(guest);
  return guest;
}

function validateGuestInput(value: unknown): {
  name: string;
  email: string;
  phone: string;
  group: string;
  note: string;
  classType?: Guest["classType"];
  classNumber?: string;
} & RosterFields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError(400, "VALIDATION_ERROR", "嘉賓資料格式不正確");
  const item = value as Record<string, unknown>;
  const classes = validateClass(item.classType, item.classNumber, false);
  return {
    ...validateRosterFields(item),
    ...classes,
    name: text(item.name, "嘉賓姓名", { max: 120 })!,
    email: optionalContact(item.email, "電郵"),
    phone: optionalContact(item.phone, "電話"),
    group:
      text(item.group, "嘉賓分組", { optional: true, min: 0, max: 120 }) ||
      classLabel(classes),
    note:
      text(item.note, "嘉賓備註", { optional: true, min: 0, max: MAX_TEXT }) ??
      "",
  };
}

function validateClass(type: unknown, number: unknown, required: boolean) {
  try {
    return parseClass(type, number, required);
  } catch (error) {
    throw new DomainError(
      400,
      "INVALID_CLASS",
      error instanceof Error ? error.message : "班級資料不正確"
    );
  }
}

function publicGuestInput(body: Record<string, unknown>, event: EventInfo) {
  if (event.mode !== "attendance")
    return validateGuestInput({
      name: body.name,
      email: body.email,
      phone: body.phone,
    });
  const classes = validateClass(body.classType, body.classNumber, true);
  let phone: string;
  try {
    phone = registrationPhone(body.phone);
  } catch (error) {
    throw new DomainError(
      400,
      "INVALID_PHONE",
      error instanceof Error ? error.message : "電話不正確"
    );
  }
  return validateGuestInput({
    name: body.name,
    phone,
    ...classes,
    group: classLabel(classes),
  });
}

function rosterIdentityInput(body:Record<string,unknown>):RosterIdentityInput {
  const classes=validateClass(body.classType,body.classNumber,false);
  let phone:string;
  try {phone=registrationPhone(body.phone);} catch(e){throw new DomainError(400,"INVALID_PHONE",e instanceof Error?e.message:"電話格式不正確");}
  return {name:text(body.name,"嘉賓姓名",{max:120})!,chapter:text(body.chapter,"分會",{max:120})!,invitedBy:text(body.invitedBy,"邀請人",{optional:true,min:0,max:120})||"",phone,...classes};
}

function rosterSearchInput(body: Record<string, unknown>): RosterSearchInput {
  return {
    name: text(body.name, "嘉賓姓名", { max: 120 })!,
    chapter: text(body.chapter, "自報分會", { optional: true, min: 0, max: 120 }) || "",
    invitedBy: text(body.invitedBy, "邀請人", { optional: true, min: 0, max: 120 }) || "",
    classType: text(body.classType, "班種", { optional: true, min: 0, max: 16 }) || "",
    classNumber: text(body.classNumber, "班號", { optional: true, min: 0, max: 16 }) || "",
  };
}

function rosterSelectionInput(body: Record<string, unknown>): RosterSelectionInput {
  const fields = rosterSearchInput(body);
  try {
    return { ...fields, phone: registrationPhone(body.phone) };
  } catch {
    throw new DomainError(400, "INVALID_PHONE", "確認登記時請填寫本人電話。");
  }
}

function validateSeatingImportRow(value: unknown): SeatingImportRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(400, "VALIDATION_ERROR", "座位表資料格式不正確");
  }
  const item = value as Record<string, unknown>;
  const ticket =
    text(item.ticket, "票號", { optional: true, min: 0, max: 40 }) ?? "";
  const name =
    text(item.name, "嘉賓姓名", { optional: true, min: 0, max: 120 }) ?? "";
  if (!ticket && !name) {
    throw new DomainError(
      400,
      "SEATING_GUEST_REQUIRED",
      "座位表每列必須提供票號或嘉賓姓名"
    );
  }
  return {
    ticket,
    name,
    tableNumber: finiteNumber(item.tableNumber, "枱號", 1, 9_999, true),
    tableLabel:
      text(item.tableLabel, "圍枱名稱", { optional: true, min: 0, max: 120 }) ??
      "",
    seat: finiteNumber(item.seat, "座位", 1, 12, true),
  };
}

function validateBrand(value: unknown): EventInfo["brand"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError(400, "VALIDATION_ERROR", "品牌設定格式不正確");
  const brand = value as Record<string, unknown>;
  const name = text(brand.name, "品牌名稱", { max: 120 })!;
  const color = text(brand.color, "品牌顏色", { max: 7 })!;
  if (!/^#[0-9a-f]{6}$/iu.test(color))
    throw new DomainError(400, "VALIDATION_ERROR", "品牌顏色格式不正確");
  const logoUrl =
    text(brand.logoUrl, "Logo網址", { optional: true, min: 0, max: 2048 }) ??
    "";
  if (!validLogoAddress(logoUrl))
    throw new DomainError(
      400,
      "VALIDATION_ERROR",
      "Logo只接受持久HTTPS網址或 /manus-storage/ 資產路徑"
    );
  return {
    name,
    color,
    logoUrl,
    privacyText:
      text(brand.privacyText, "私隱說明", {
        optional: true,
        min: 0,
        max: MAX_TEXT,
      }) ?? "",
  };
}

function stateFor(
  aggregate: EventAggregate,
  access: Access,
  members: Member[]
): WorkspaceState {
  const event = aggregate.event;
  const attendanceOnly = event.mode === "attendance";
  const guests = aggregate.guests.map(guest => ({
    ...guest,
    chances: availableChances(aggregate, guest.id),
  }));
  if (
    access.role === "owner" ||
    access.role === "admin" ||
    access.role === "project_manager"
  ) {
    return {
      event,
      role: access.role,
      guests,
      tables: aggregate.tables,
      merchants: attendanceOnly ? [] : aggregate.merchants,
      receipts: attendanceOnly ? [] : aggregate.receipts,
      payments: attendanceOnly ? [] : aggregate.payments,
      prizes: attendanceOnly ? [] : aggregate.prizes,
      draws: attendanceOnly ? [] : aggregate.draws.map(drawDto),
      members: access.role === "project_manager" ? [] : members,
      audit: aggregate.audit,
    };
  }
  if (access.role === "checkin" || access.role === "guest_manager") {
    return {
      event: basicEvent(event) as EventInfo,
      role: access.role,
      guests: access.role === "checkin" ? eventGuests(event, guests) : guests,
      tables: aggregate.tables,
      merchants: [],
      receipts: [],
      payments: [],
      prizes: [],
      draws: [],
      members: [],
      audit: [],
    };
  }
  if (access.role === "draw") {
    return {
      event: basicEvent(event) as EventInfo,
      role: access.role,
      guests: guests.map(publicGuest) as Guest[],
      tables: [],
      merchants: [],
      receipts: [],
      payments: [],
      prizes: aggregate.prizes,
      draws: aggregate.draws.map(drawDto),
      members: [],
      audit: [],
    };
  }
  const merchant = aggregate.merchants.filter(
    item => item.id === access.merchantId
  );
  const receipts = aggregate.receipts.filter(
    item => item.merchantId === access.merchantId
  );
  return {
    event: basicEvent(event) as EventInfo,
    role: access.role,
    guests: [],
    tables: [],
    merchants: merchant,
    receipts,
    payments: [],
    prizes: [],
    draws: [],
    members: [],
    audit: [],
  };
}

function assertBoundEvent(row: { owner_user_id: number | null } | undefined): void {
  if (!row || row.owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
}

async function readEvent(eventId: string): Promise<PublicEventRow> {
  const rows = await readRows<PublicEventRow>(
    "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE id = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) LIMIT 1",
    [eventId]
  );
  const row = rows[0];
  if (!row || row.owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
  return row;
}

async function readAccess(
  row: PublicEventRow,
  user: AuthenticatedUser
): Promise<Access | null> {
  if (row.owner_user_id == null) return null;
  const globalRole = await systemRoleFor(user);
  if (globalRole !== "user") return { role: globalRole, merchantId: null };
  if (row.owner_user_id === user.id) return { role: "owner", merchantId: null };
  const members = await readRows<MemberRow>(
    "SELECT id,event_id,user_id,name,role,merchant_id,active,created_at,updated_at FROM ef_members WHERE event_id = ? AND user_id = ? AND active = 1 LIMIT 1",
    [row.id, user.id]
  );
  const member = members[0];
  return member ? { role: member.role, merchantId: member.merchant_id } : null;
}

function ensureMerchantScope(access: Access, merchantId: string): void {
  if (access.role === "merchant" && access.merchantId !== merchantId) {
    throw new DomainError(403, "MERCHANT_SCOPE", "你不能操作其他商戶資料");
  }
}

function recordLedger(
  aggregate: EventAggregate,
  input: {
    guestId: string;
    receiptId: string | null;
    ruleVersion: number;
    delta: number;
    kind: LedgerEntry["kind"];
    now: Date;
  }
): LedgerEntry | null {
  if (!input.delta) return null;
  const entry: LedgerEntry = {
    id: randomUUID(),
    guestId: input.guestId,
    receiptId: input.receiptId,
    ruleVersion: input.ruleVersion,
    delta: input.delta,
    kind: input.kind,
    createdAt: nowIso(input.now),
  };
  aggregate.ledger.push(entry);
  return entry;
}

function receiptTokenPath(token: string): string {
  return `/guest#claim=${token}`;
}

function csvCell(value: unknown): string {
  let textValue = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
  return `"${textValue.replace(/"/g, '""')}"`;
}

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof DomainError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof HttpError) {
    const status = error.statusCode === 403 ? 401 : error.statusCode;
    res.status(status).json({
      error: status === 401 ? "請先登入" : "請求失敗",
      code: status === 401 ? "UNAUTHORIZED" : "REQUEST_FAILED",
    });
    return;
  }
  // Never reveal SQL, host, token, or driver internals through this API.
  res.status(503).json({
    error: "服務暫時無法處理，請稍後再試",
    code: "SERVICE_UNAVAILABLE",
  });
}

function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) =>
    void handler(req, res).catch((error: unknown) => handleError(res, error));
}

/** Registers the complete EventFlow REST API. The caller owns the application mount lifecycle. */
export function registerEventFlowRoutes(app: Express): void {
  const router = Router();

  // No caller-supplied identity or target: the fixed initializer pair is claimed
  // only by the currently authenticated, verified allowlisted Google account.
  router.get("/system/pending-ownership", route(async (req, res) => {
    const user = await authenticated(req);
    res.set("Cache-Control", "no-store");
    res.json(await listPendingOwnership(user));
  }));
  router.post("/system/pending-ownership/claim", route(async (req, res) => {
    if (!req.get("origin")) throw new DomainError(403, "ORIGIN_REQUIRED", "請從本站操作");
    const fetchSite = req.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin")
      throw new DomainError(403, "ORIGIN_FORBIDDEN", "不接受跨站請求");
    const user = await authenticatedMutation(req);
    const body = bodyObject(req);
    if (Object.keys(body).length) throw new DomainError(400, "INVALID_BODY", "此操作不接受額外資料");
    res.set("Cache-Control", "no-store");
    res.json(await claimPendingOwnership(user));
  }));

  router.get(
    "/system/access",
    route(async (req, res) => {
      const user = await authenticated(req);
      const role = await systemRoleFor(user);
      if (role === "user")
        throw new DomainError(
          403,
          "FORBIDDEN",
          "只有系統擁有人或系統管理員可以管理帳戶授權"
        );
      res.json(await accessDirectory(role === "owner"));
    })
  );

  router.patch(
    "/system/access/:id",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      if (!isSystemOwner(user))
        throw new DomainError(
          403,
          "OWNER_REQUIRED",
          "只有系統擁有人可以委任系統管理員"
        );
      const body = bodyObject(req);
      if (typeof body.systemAdmin !== "boolean")
        throw new DomainError(400, "VALIDATION_ERROR", "請指定管理員狀態");
      const targetId = Number(req.params.id);
      if (!Number.isSafeInteger(targetId) || targetId <= 0)
        throw new DomainError(400, "VALIDATION_ERROR", "帳戶不正確");
      const key = requireIdempotencyKey(req);
      const result = await withTransaction(async connection => {
        const [targets] = await connection.query<RowDataPacket[]>(
          "SELECT id,email,loginMethod FROM users WHERE id = ? FOR UPDATE",
          [targetId]
        );
        const target = targets[0];
        if (!target || target.loginMethod !== "google_direct")
          throw new DomainError(
            404,
            "USER_NOT_FOUND",
            "此用戶尚未完成Google登入"
          );
        if (
          isSystemOwner({
            email: target.email,
            authProvider: "google",
            emailVerified: true,
          })
        )
          throw new DomainError(
            409,
            "OWNER_PROTECTED",
            "不能變更系統擁有人的權限"
          );
        return replayOrStore(
          connection,
          {
            eventId: "system-access",
            action: "system.admin",
            actorScope: `user:${user.id}`,
            key,
            body: { targetId, ...body },
            now: new Date(),
          },
          async () => {
            const now = sqlDate(new Date());
            await connection.execute(
              "INSERT INTO ef_system_admins (user_id,granted_by,active,created_at,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE granted_by=VALUES(granted_by),active=VALUES(active),updated_at=VALUES(updated_at)",
              [targetId, user.id, body.systemAdmin ? 1 : 0, now, now]
            );
            await connection.execute(
              "INSERT INTO ef_access_audit (id,actor_user_id,target_user_id,action,created_at) VALUES (?,?,?,?,?)",
              [
                randomUUID(),
                user.id,
                targetId,
                body.systemAdmin
                  ? "system.admin_granted"
                  : "system.admin_revoked",
                now,
              ]
            );
            return { ok: true };
          }
        );
      });
      res.json(result);
    })
  );

  router.post(
    "/events/:eventId/members/assign",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const targetId = Number(body.userId);
      if (!Number.isSafeInteger(targetId) || targetId <= 0)
        throw new DomainError(400, "VALIDATION_ERROR", "帳戶不正確");
      const role = body.role;
      if (!STAFF_ROLES.includes(role as (typeof STAFF_ROLES)[number]))
        throw new DomainError(400, "VALIDATION_ERROR", "不能指派此角色");
      const result = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "member.assign",
        ["owner", "admin"],
        async ({ connection, row, aggregate, now }) => {
          if (
            aggregate.event.mode === "attendance" &&
            (role === "merchant" || role === "draw")
          )
            throw new DomainError(
              409,
              "FEATURE_DISABLED",
              "此典禮不使用商戶或抽獎角色"
            );
          const [targets] = await connection.query<RowDataPacket[]>(
            "SELECT id,name,email,loginMethod FROM users WHERE id = ? FOR UPDATE",
            [targetId]
          );
          const target = targets[0];
          if (!target || target.loginMethod !== "google_direct")
            throw new DomainError(
              404,
              "USER_NOT_FOUND",
              "請用戶先完成Google登入，才可分配角色"
            );
          if (
            row.owner_user_id === targetId ||
            isSystemOwner({
              email: target.email,
              authProvider: "google",
              emailVerified: true,
            })
          )
            throw new DomainError(409, "OWNER_PROTECTED", "不能改寫擁有人身份");
          const merchantId =
            role === "merchant"
              ? text(body.merchantId, "商戶", { max: 36 })!
              : null;
          if (
            role === "merchant" &&
            !aggregate.merchants.some(m => m.id === merchantId && m.active)
          )
            throw new DomainError(
              400,
              "MERCHANT_REQUIRED",
              "必須指定本活動的有效商戶"
            );
          const [members] = await connection.query<MemberRow[]>(
            "SELECT * FROM ef_members WHERE event_id = ? AND user_id = ? FOR UPDATE",
            [row.id, targetId]
          );
          const id = members[0]?.id || randomUUID();
          await connection.execute(
            "INSERT INTO ef_members (id,event_id,user_id,name,role,merchant_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),role=VALUES(role),merchant_id=VALUES(merchant_id),active=1,updated_at=VALUES(updated_at)",
            [
              id,
              row.id,
              targetId,
              target.name || target.email,
              role,
              merchantId,
              sqlDate(now),
              sqlDate(now),
            ]
          );
          addAudit(
            aggregate,
            "member.assigned",
            `user:${user.id}`,
            `已為帳戶${targetId}指派${role}`,
            now
          );
          return { ok: true, memberId: id };
        }
      );
      res.json(result);
    })
  );

  router.get(
    "/session",
    route(async (req, res) => {
      const user = await authenticated(req);
      const systemRole = await systemRoleFor(user);
      const isGlobal = systemRole !== "user";
      const organizations = await readRows<OrganizationRow>(
        isGlobal
          ? "SELECT id,name,owner_user_id FROM ef_organizations WHERE owner_user_id IS NOT NULL ORDER BY name ASC"
          : "SELECT DISTINCT o.id,o.name,o.owner_user_id FROM ef_organizations o LEFT JOIN ef_events e ON e.tenant_id = o.id AND e.owner_user_id IS NOT NULL LEFT JOIN ef_members m ON m.event_id = e.id AND m.user_id = ? AND m.active = 1 WHERE o.owner_user_id IS NOT NULL AND (o.owner_user_id = ? OR m.user_id = ?) ORDER BY o.name ASC",
        isGlobal ? [] : [user.id, user.id, user.id]
      );
      const events = await readRows<
        PublicEventRow & {
          member_role: Access["role"] | null;
          merchant_id: string | null;
        }
      >(
        isGlobal
          ? "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) ORDER BY updated_at DESC"
          : SESSION_EVENTS_SQL,
        isGlobal ? [] : [user.id, user.id, user.id]
      );
      const payload: Session = {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          systemRole,
          provider: user.authProvider === "google" ? "google" : "manus",
        },
        canCreateEvents: isGlobal,
        canManageAccess: isGlobal,
        organizations: organizations.map(organization => ({
          id: organization.id,
          name: organization.name,
        })),
        events: events.map(row => ({
          ...parseAggregate(row.event_state).event,
          role: isGlobal
            ? systemRole
            : row.owner_user_id === user.id
              ? "owner"
              : row.member_role!,
        })),
      };
      res.json(payload);
    })
  );

  router.post(
    "/organizations",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      if ((await systemRoleFor(user)) === "user")
        throw new DomainError(
          403,
          "APPROVAL_REQUIRED",
          "請等待系統擁有人授權，不可自行建立大會"
        );
      const name = text(body.name, "組織名稱", { max: 200 })!;
      const key = requireIdempotencyKey(req);
      const response = await withTransaction(async connection => {
        const now = new Date();
        return replayOrStore(
          connection,
          {
            eventId: `org:${user.id}`,
            action: "organization.create",
            actorScope: `user:${user.id}`,
            key,
            body,
            now,
          },
          async () => {
            const id = randomUUID();
            await connection.execute(
              "INSERT INTO ef_organizations (id,owner_user_id,name,created_at) VALUES (?,?,?,?)",
              [id, user.id, name, sqlDate(now)]
            );
            return { id, name };
          }
        );
      });
      res.status(201).json(response);
    })
  );

  router.post(
    "/events",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const tenantId = text(body.tenantId, "組織", { max: 36 })!;
      const name = text(body.name, "活動名稱", { max: 200 })!;
      const date = requireIsoDate(body.date);
      const venue =
        body.venue === undefined
          ? ""
          : text(body.venue, "場地", { min: 0, max: 300 })!;
      const mode = eventMode(body.mode);
      const brandName = text(body.brandName, "品牌名稱", {
        optional: true,
        min: 0,
        max: 120,
      });
      const program =
        body.program === undefined
          ? emptyProgram()
          : validateProgram(body.program);
      const key = requireIdempotencyKey(req);
      const response = await withTransaction(async connection => {
        const [organizations] = await connection.query<OrganizationRow[]>(
          "SELECT id,name,owner_user_id FROM ef_organizations WHERE id = ? FOR UPDATE",
          [tenantId]
        );
        const organization = organizations[0];
        if (!organization || organization.owner_user_id == null)
          throw new DomainError(404, "ORGANIZATION_NOT_FOUND", "找不到組織");
        if ((await systemRoleFor(user, connection)) === "user")
          throw new DomainError(
            403,
            "FORBIDDEN",
            "只有系統擁有人或系統管理員可以建立活動"
          );
        const now = new Date();
        return replayOrStore(
          connection,
          {
            // Before an event exists, its owning tenant is the stable scope.
            eventId: tenantId,
            action: "event.create",
            actorScope: `user:${user.id}`,
            key,
            body,
            now,
          },
          async () => {
            const event = defaultEvent({
              id: randomUUID(),
              tenantId,
              name,
              date,
              venue,
              brandName,
              mode,
              program,
            });
            const aggregate = newAggregate(event);
            await connection.execute(
              "INSERT INTO ef_events (id,tenant_id,owner_user_id,slug,event_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
              [
                event.id,
                tenantId,
                user.id,
                event.slug,
                JSON.stringify(aggregate),
                sqlDate(now),
                sqlDate(now),
              ]
            );
            return event;
          }
        );
      });
      res.status(201).json(response);
    })
  );

  router.get(
    "/events/:eventId/state",
    route(async (req, res) => {
      const user = await authenticated(req);
      const row = await readEvent(req.params.eventId);
      const access = requireRole(await readAccess(row, user), [
        "owner",
        "admin",
        "project_manager",
        "guest_manager",
        "checkin",
        "draw",
        "merchant",
      ]);
      const aggregate = parseAggregate(row.event_state);
      const members =
        access.role === "owner" || access.role === "admin"
          ? (
              await readRows<MemberRow>(
                "SELECT id,event_id,user_id,name,role,merchant_id,active,created_at,updated_at FROM ef_members WHERE event_id = ? ORDER BY created_at ASC",
                [row.id]
              )
            ).map(memberDto)
          : [];
      res.json(stateFor(aggregate, access, members));
    })
  );

  router.patch(
    "/events/:eventId/settings",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "settings",
        ["owner", "admin", "project_manager"],
        async ({ aggregate, now }) => {
          const event = aggregate.event;
          if (body.name !== undefined)
            event.name = text(body.name, "活動名稱", { max: 200 })!;
          if (body.date !== undefined) event.date = requireIsoDate(body.date);
          if (body.venue !== undefined)
            event.venue = text(body.venue, "場地", { min: 0, max: 300 })!;
          if (body.status !== undefined) {
            if (
              body.status !== "draft" &&
              body.status !== "live" &&
              body.status !== "closed"
            )
              throw new DomainError(400, "VALIDATION_ERROR", "活動狀態不正確");
            event.status = body.status;
          }
          if (body.brand !== undefined) event.brand = validateBrand(body.brand);
          if (body.program !== undefined)
            event.program = validateProgram(body.program);
          if (body.registrationOpen !== undefined)
            event.registrationOpen = bool(
              body.registrationOpen,
              "開放登記設定"
            );
          if (body.registrationCheckIn !== undefined)
            event.registrationCheckIn = bool(
              body.registrationCheckIn,
              "自助到場設定"
            );
          if (body.rosterClaimEnabled !== undefined) {
            const enabled=bool(body.rosterClaimEnabled,"預排名單認領設定");
            if(enabled && event.mode!=="attendance")throw new DomainError(409,"FEATURE_DISABLED","只有簽到典禮可開啟預排名單核對");
            event.rosterClaimEnabled=enabled;
            event.rosterChapters=[...new Set(aggregate.guests.map(g=>g.chapter?.trim()).filter((v):v is string=>Boolean(v)))];
            if(!event.rosterChapters.length)event.rosterChapters=[...CHAPTERS];
          }
          if (body.excludeWinners !== undefined)
            event.excludeWinners = bool(body.excludeWinners, "排除得獎者設定");
          let rulesChanged = false;
          if (body.thresholdCents !== undefined) {
            const threshold = integerCents(body.thresholdCents, "門檻");
            if (threshold !== event.thresholdCents) {
              event.thresholdCents = threshold;
              rulesChanged = true;
            }
          }
          if (body.accumulation !== undefined) {
            if (
              body.accumulation !== "per_transaction" &&
              body.accumulation !== "cumulative"
            )
              throw new DomainError(400, "VALIDATION_ERROR", "累積模式不正確");
            if (body.accumulation !== event.accumulation) {
              event.accumulation = body.accumulation;
              rulesChanged = true;
            }
          }
          if (rulesChanged) event.ruleVersion += 1;
          addAudit(
            aggregate,
            "settings.updated",
            `user:${user.id}`,
            rulesChanged ? "已建立新規則版本" : "已更新活動設定",
            now
          );
          return event;
        }
      );
      res.json(response);
    })
  );

  router.post(
    "/events/:eventId/copy",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "copy",
        ["owner", "admin"],
        async ({ connection, aggregate, row, now }) => {
          const name = text(body.name, "新活動名稱", { max: 200 })!;
          const id = randomUUID();
          const copiedEvent: EventInfo = {
            ...aggregate.event,
            id,
            name,
            slug: slugFor(name),
            date: requireIsoDate(aggregate.event.date),
            brand: { ...aggregate.event.brand },
          };
          const copied = newAggregate(copiedEvent);
          copied.tables = aggregate.tables.map(table => ({
            ...table,
            id: randomUUID(),
            eventId: id,
          }));
          const merchantIdMap = new Map<string, string>();
          copied.merchants = aggregate.merchants.map(merchant => {
            const merchantId = randomUUID();
            merchantIdMap.set(merchant.id, merchantId);
            return {
              ...merchant,
              id: merchantId,
              eventId: id,
              createdAt: nowIso(now),
            };
          });
          copied.prizes = aggregate.prizes.map(prize => ({
            id: randomUUID(),
            name: prize.name,
            drawId: null,
          }));
          await connection.execute(
            "INSERT INTO ef_events (id,tenant_id,owner_user_id,slug,event_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
            [
              id,
              row.tenant_id,
              row.owner_user_id,
              copiedEvent.slug,
              JSON.stringify(copied),
              sqlDate(now),
              sqlDate(now),
            ]
          );
          if (user.id !== row.owner_user_id) {
            await connection.execute(
              "INSERT INTO ef_members (id,event_id,user_id,name,role,merchant_id,active,created_at,updated_at) VALUES (?,?,?,?, 'admin',NULL,1,?,?)",
              [
                randomUUID(),
                id,
                user.id,
                user.name || "活動建立者",
                sqlDate(now),
                sqlDate(now),
              ]
            );
          }
          addAudit(
            aggregate,
            "event.copied",
            `user:${user.id}`,
            "已複製活動設定",
            now
          );
          return copiedEvent;
        }
      );
      res.status(201).json(response);
    })
  );

  router.post(
    "/events/:eventId/members",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "member.invite",
        ["owner", "admin"],
        async ({ connection, aggregate, now }) => {
          const role = body.role;
          if (!STAFF_ROLES.includes(role as (typeof STAFF_ROLES)[number]))
            throw new DomainError(
              400,
              "VALIDATION_ERROR",
              "工作人員角色不正確"
            );
          if (
            aggregate.event.mode === "attendance" &&
            (role === "merchant" || role === "draw")
          ) {
            throw new DomainError(
              409,
              "FEATURE_DISABLED",
              "簽到典禮只可邀請管理員或簽到人員"
            );
          }
          const name = text(body.name, "工作人員名稱", { max: 200 })!;
          const merchantId =
            body.merchantId === undefined || body.merchantId === null
              ? null
              : text(body.merchantId, "商戶", { max: 36 })!;
          if (role === "merchant") {
            if (
              !merchantId ||
              !aggregate.merchants.some(merchant => merchant.id === merchantId)
            )
              throw new DomainError(
                400,
                "MERCHANT_REQUIRED",
                "商戶角色必須指定本活動商戶"
              );
          } else if (merchantId) {
            throw new DomainError(
              400,
              "VALIDATION_ERROR",
              "只有商戶角色可指定商戶"
            );
          }
          const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          const issued = await insertInvite(connection, {
            eventId: aggregate.event.id,
            kind: "staff",
            role: role as
              | "admin"
              | "project_manager"
              | "guest_manager"
              | "checkin"
              | "draw"
              | "merchant",
            merchantId,
            name,
            expiresAt: expires,
            now,
          });
          addAudit(
            aggregate,
            "member.invited",
            `user:${user.id}`,
            `已邀請${role}工作人員`,
            now
          );
          return invitation(issued.token, "staff", issued.expiresAt);
        }
      );
      res.status(201).json(response);
    })
  );

  router.post(
    "/invites/accept",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const token = text(body.token, "邀請憑證", { max: 512 })!;
      const key = requireIdempotencyKey(req);
      const response = await withTransaction(async connection => {
        const [invites] = await connection.query<InviteRow[]>(
          "SELECT * FROM ef_invites WHERE token_hash = ? FOR UPDATE",
          [sha256(token)]
        );
        const invite = invites[0];
        if (!invite || invite.kind !== "staff")
          throw new DomainError(
            404,
            "INVITE_NOT_FOUND",
            "找不到有效工作人員邀請"
          );
        const row = await lockedEventRow(connection, invite.event_id);
        assertBoundEvent(row);
        const aggregate = parseAggregate(row.event_state);
        const now = new Date();
        return replayOrStore(
          connection,
          {
            eventId: row.id,
            action: "member.accept",
            actorScope: `user:${user.id}`,
            key,
            body,
            now,
          },
          async () => {
            assertInviteUsable(invite, now);
            if (row.owner_user_id === user.id || isSystemOwner(user))
              throw new DomainError(
                409,
                "OWNER_PROTECTED",
                "組織擁有人不可被邀請角色覆寫"
              );
            const [existing] = await connection.query<MemberRow[]>(
              "SELECT * FROM ef_members WHERE event_id = ? AND user_id = ? FOR UPDATE",
              [row.id, user.id]
            );
            if (existing[0])
              throw new DomainError(
                409,
                "MEMBERSHIP_EXISTS",
                "此帳戶已擁有活動角色"
              );
            if (!invite.role || !invite.name)
              throw new DomainError(
                503,
                "INVITE_INVALID",
                "工作人員邀請資料不完整"
              );
            await connection.execute(
              "INSERT INTO ef_members (id,event_id,user_id,name,role,merchant_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
              [
                randomUUID(),
                row.id,
                user.id,
                invite.name,
                invite.role,
                invite.merchant_id,
                1,
                sqlDate(now),
                sqlDate(now),
              ]
            );
            await connection.execute(
              "UPDATE ef_invites SET consumed_by_user_id = ?, consumed_at = ? WHERE id = ?",
              [user.id, sqlDate(now), invite.id]
            );
            addAudit(
              aggregate,
              "member.accepted",
              `user:${user.id}`,
              `已接受${invite.role}工作人員邀請`,
              now
            );
            await saveAggregate(connection, row.id, aggregate, now);
            return { eventId: row.id, role: invite.role };
          }
        );
      });
      res.json(response);
    })
  );

  router.patch(
    "/events/:eventId/members/:id",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "member.disable",
        ["owner", "admin"],
        async ({ connection, aggregate, now }) => {
          if (body.active !== false)
            throw new DomainError(
              400,
              "VALIDATION_ERROR",
              "此端點只支援停用成員"
            );
          const [members] = await connection.query<MemberRow[]>(
            "SELECT * FROM ef_members WHERE id = ? AND event_id = ? FOR UPDATE",
            [req.params.id, aggregate.event.id]
          );
          const member = members[0];
          if (!member)
            throw new DomainError(404, "MEMBER_NOT_FOUND", "找不到活動成員");
          await connection.execute(
            "UPDATE ef_members SET active = 0, updated_at = ? WHERE id = ?",
            [sqlDate(now), member.id]
          );
          addAudit(
            aggregate,
            "member.disabled",
            `user:${user.id}`,
            "已停用工作人員",
            now
          );
          return { ok: true };
        }
      );
      res.json(response);
    })
  );

  router.post(
    "/events/:eventId/guests",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const input = validateGuestInput(body);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "guest.create",
        ["owner", "admin", "project_manager", "guest_manager"],
        async ({ connection, aggregate, now }) => {
          const guest = createGuest(aggregate, input, now);
          const issued = await insertInvite(connection, {
            eventId: aggregate.event.id,
            kind: "guest",
            guestId: guest.id,
            now,
          });
          addAudit(
            aggregate,
            "guest.created",
            `user:${user.id}`,
            "已建立嘉賓",
            now
          );
          return { guest, invitation: invitation(issued.token, "guest") };
        }
      );
      res.status(201).json(response);
    })
  );

  router.post(
    "/events/:eventId/guests/import",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      if (
        !Array.isArray(body.rows) ||
        body.rows.length === 0 ||
        body.rows.length > MAX_GUESTS_IMPORT
      ) {
        throw new DomainError(
          400,
          "IMPORT_LIMIT",
          `每次只可匯入1至${MAX_GUESTS_IMPORT}名嘉賓`
        );
      }
      const rows = body.rows.map(validateGuestInput);
      const rosterKeys = new Set<string>();
      for (const input of rows) {
        if (input.rosterKey) {
          if (rosterKeys.has(input.rosterKey))
            throw new DomainError(409, "ROSTER_KEY_EXISTS", "匯入資料含重複名單編號");
          rosterKeys.add(input.rosterKey);
        }
      }
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "guest.import",
        ["owner", "admin", "project_manager", "guest_manager"],
        async ({ connection, aggregate, now }) => {
          const invitations: { guest: Guest; invitation: Invitation }[] = [];
          const staged = { ...aggregate, guests: aggregate.guests.map(guest => ({ ...guest })) };
          const imported: Guest[] = [];
          let created=0,updated=0;
          for (const input of rows) {
            assertExclusionMode(aggregate.event, input);
            let guest=input.rosterKey?staged.guests.find(g=>g.rosterKey===input.rosterKey):undefined;
            if(guest){
              const next={...guest,...input,phone:input.phone||guest.phone,email:input.email||guest.email,classType:input.classType||guest.classType,classNumber:input.classType?input.classNumber:guest.classNumber};
              assertActiveContactUnique(staged, next);
              if (isExcludedFromEvent(aggregate.event, next)) { next.tableId=null; next.seat=null; }
              Object.assign(guest,next);updated++;
            }else{guest=createGuest(staged,input,now);created++;}
            imported.push(guest);
          }
          aggregate.guests = staged.guests;
          for (const guest of imported) {
            const issued = await insertInvite(connection, {
              eventId: aggregate.event.id,
              kind: "guest",
              guestId: guest.id,
              now,
            });
            invitations.push({
              guest,
              invitation: invitation(issued.token, "guest"),
            });
          }
          addAudit(
            aggregate,
            "guest.imported",
            `user:${user.id}`,
            `已匯入${rows.length}名嘉賓`,
            now
          );
          return { created, updated, invitations };
        }
      );
      res.status(201).json(response);
    })
  );

  router.patch(
    "/events/:eventId/guests/:id",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "guest.update",
        ["owner", "admin", "project_manager", "guest_manager"],
        async ({ aggregate, now }) => {
          const index = aggregate.guests.findIndex(
            guest => guest.id === req.params.id
          );
          if (index < 0)
            throw new DomainError(404, "GUEST_NOT_FOUND", "找不到嘉賓");
          const guest = aggregate.guests[index];
          const next = { ...guest };
          if (body.name !== undefined)
            next.name = text(body.name, "嘉賓姓名", { max: 120 })!;
          if (body.email !== undefined)
            next.email = optionalContact(body.email, "電郵");
          if (body.phone !== undefined)
            next.phone = optionalContact(body.phone, "電話");
          if (body.classType !== undefined || body.classNumber !== undefined) {
            Object.assign(
              next,
              validateClass(
                body.classType ?? next.classType,
                body.classNumber ?? next.classNumber,
                false
              )
            );
          }
          Object.assign(next,validateRosterFields(body));
          // A legacy full-mode flag remains inert; only reject newly setting true.
          if (body.excludedFromEvent !== undefined) assertExclusionMode(aggregate.event, next);
          if (isExcludedFromEvent(aggregate.event, next)) { next.tableId=null; next.seat=null; }
          if(next.chapter && !next.rosterKey) next.rosterKey=`manual:${next.id}`;
          if (next.rosterKey && aggregate.guests.some(item => item.id !== next.id && item.rosterKey === next.rosterKey))
            throw new DomainError(409, "ROSTER_KEY_EXISTS", "此名單編號已存在，請編輯現有嘉賓");
          if (body.group !== undefined)
            next.group = text(body.group, "嘉賓分組", { min: 0, max: 120 })!;
          if (body.note !== undefined)
            next.note = text(body.note, "嘉賓備註", { min: 0, max: MAX_TEXT })!;
          if (
            (body.classType !== undefined || body.classNumber !== undefined) &&
            next.group === classLabel(guest)
          ) {
            next.group = classLabel(next);
          }
          assertActiveContactUnique(aggregate, next);
          aggregate.guests[index] = next;
          addAudit(
            aggregate,
            "guest.updated",
            `user:${user.id}`,
            "已更新嘉賓資料",
            now
          );
          return next;
        }
      );
      res.json(response);
    })
  );

  router.post(
    "/events/:eventId/guests/:id/invitation",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "guest.invite.rotate",
        ["owner", "admin", "project_manager", "guest_manager"],
        async ({ connection, aggregate, now }) => {
          const guest = aggregate.guests.find(
            item => item.id === req.params.id
          );
          if (!guest)
            throw new DomainError(404, "GUEST_NOT_FOUND", "找不到嘉賓");
          assertParticipating(aggregate.event, guest);
          const [existing] = await connection.query<InviteRow[]>(
            "SELECT * FROM ef_invites WHERE event_id = ? AND guest_id = ? AND kind = 'guest' AND revoked_at IS NULL FOR UPDATE",
            [aggregate.event.id, guest.id]
          );
          const version =
            Math.max(0, ...existing.map(invite => invite.version)) + 1;
          if (existing.length)
            await connection.execute(
              "UPDATE ef_invites SET revoked_at = ? WHERE event_id = ? AND guest_id = ? AND kind = 'guest' AND revoked_at IS NULL",
              [sqlDate(now), aggregate.event.id, guest.id]
            );
          const issued = await insertInvite(connection, {
            eventId: aggregate.event.id,
            kind: "guest",
            guestId: guest.id,
            version,
            now,
          });
          addAudit(
            aggregate,
            "guest.invite.rotated",
            `user:${user.id}`,
            "已更新嘉賓邀請連結",
            now
          );
          return invitation(issued.token, "guest");
        }
      );
      res.json(response);
    })
  );

  router.post(
    "/events/:eventId/checkin",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "guest.checkin",
        ["owner", "admin", "project_manager", "guest_manager", "checkin"],
        async ({ connection, aggregate, now }) => {
          const manualGuestId =
            body.guestId === undefined
              ? undefined
              : text(body.guestId, "嘉賓", { max: 36 })!;
          const token =
            body.token === undefined
              ? undefined
              : text(body.token, "邀請憑證", { max: 512 })!;
          if ((manualGuestId ? 1 : 0) + (token ? 1 : 0) !== 1)
            throw new DomainError(
              400,
              "CHECKIN_METHOD_REQUIRED",
              "請提供嘉賓或邀請憑證其中之一"
            );
          let guestId = manualGuestId;
          if (token) {
            const [invites] = await connection.query<InviteRow[]>(
              "SELECT * FROM ef_invites WHERE token_hash = ? FOR UPDATE",
              [sha256(token)]
            );
            const invite = invites[0];
            if (!invite || invite.kind !== "guest" || invite.revoked_at)
              throw new DomainError(
                404,
                "INVITE_NOT_FOUND",
                "找不到有效嘉賓邀請"
              );
            assertEventScope(aggregate.event.id, invite.event_id);
            guestId = invite.guest_id ?? undefined;
          }
          const index = aggregate.guests.findIndex(
            guest => guest.id === guestId
          );
          if (index < 0)
            throw new DomainError(404, "GUEST_NOT_FOUND", "找不到嘉賓");
          const guest = aggregate.guests[index];
          assertParticipating(aggregate.event, guest);
          const alreadyCheckedIn = Boolean(guest.checkedInAt);
          if (!alreadyCheckedIn) {
            guest.checkedInAt = nowIso(now);
            aggregate.guests[index] = guest;
            addAudit(
              aggregate,
              "guest.checked_in",
              `user:${user.id}`,
              "嘉賓已簽到",
              now
            );
          }
          return { guest, alreadyCheckedIn };
        },
        { idempotent: false }
      );
      res.json(response);
    })
  );

  router.post(
    "/events/:eventId/tables",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "table.create",
        ["owner", "admin", "project_manager", "guest_manager"],
        async ({ aggregate, now }) => {
          const number = finiteNumber(body.number, "枱號", 1, 9999, true);
          if (aggregate.tables.some(table => table.number === number))
            throw new DomainError(409, "TABLE_NUMBER_EXISTS", "此枱號已存在");
          const capacity =
            body.capacity === undefined
              ? 12
              : finiteNumber(body.capacity, "圍枱容量", 1, 12, true);
          const table: EventTable = {
            id: randomUUID(),
            tenantId: aggregate.event.tenantId,
            eventId: aggregate.event.id,
            number,
            label:
              body.label === undefined
                ? `${number}號枱`
                : text(body.label, "圍枱標籤", { max: 120 })!,
            capacity,
            x:
              body.x === undefined ? 50 : finiteNumber(body.x, "X座標", 0, 100),
            y:
              body.y === undefined ? 50 : finiteNumber(body.y, "Y座標", 0, 100),
          };
          aggregate.tables.push(table);
          addAudit(
            aggregate,
            "table.created",
            `user:${user.id}`,
            `已建立${number}號枱`,
            now
          );
          return table;
        }
      );
      res.status(201).json(response);
    })
  );

  router.patch(
    "/events/:eventId/tables/:id",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "table.update",
        ["owner", "admin", "project_manager", "guest_manager"],
        async ({ aggregate, now }) => {
          const index = aggregate.tables.findIndex(
            table => table.id === req.params.id
          );
          if (index < 0)
            throw new DomainError(404, "TABLE_NOT_FOUND", "找不到圍枱");
          const table = { ...aggregate.tables[index] };
          if (body.label !== undefined)
            table.label = text(body.label, "圍枱標籤", { max: 120 })!;
          if (body.x !== undefined)
            table.x = finiteNumber(body.x, "X座標", 0, 100);
          if (body.y !== undefined)
            table.y = finiteNumber(body.y, "Y座標", 0, 100);
          aggregate.tables[index] = table;
          addAudit(
            aggregate,
            "table.updated",
            `user:${user.id}`,
            "已更新圍枱位置",
            now
          );
          return table;
        }
      );
      res.json(response);
    })
  );

  router.post(
    "/events/:eventId/seating",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "seating.assign",
        ["owner", "admin", "project_manager", "guest_manager"],
        async ({ aggregate, now }) => {
          const guestId = text(body.guestId, "嘉賓", { max: 36 })!;
          const tableId =
            body.tableId === null
              ? null
              : text(body.tableId, "圍枱", { max: 36 })!;
          const seat =
            body.seat === null
              ? null
              : finiteNumber(body.seat, "座位", 1, 12, true);
          assertSeatChange(aggregate.guests, aggregate.tables, {
            guestId,
            tableId,
            seat,
          }, aggregate.event.mode);
          const index = aggregate.guests.findIndex(
            guest => guest.id === guestId
          );
          const guest = { ...aggregate.guests[index], tableId, seat };
          aggregate.guests[index] = guest;
          addAudit(
            aggregate,
            "seating.assigned",
            `user:${user.id}`,
            tableId ? "已安排座位" : "已取消座位安排",
            now
          );
          return guest;
        }
      );
      res.json(response);
    })
  );

  router.post(
    "/events/:eventId/seating/import",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      if (
        !Array.isArray(body.rows) ||
        body.rows.length === 0 ||
        body.rows.length > MAX_SEATING_IMPORT
      ) {
        throw new DomainError(
          400,
          "IMPORT_LIMIT",
          `每次只可匯入1至${MAX_SEATING_IMPORT}列座位資料`
        );
      }
      const rows = body.rows.map(validateSeatingImportRow);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "seating.import",
        ["owner", "admin", "project_manager", "guest_manager"],
        async ({ aggregate, now }) => {
          const plan = planSeatingImport({
            tenantId: aggregate.event.tenantId,
            eventId: aggregate.event.id,
            guests: aggregate.guests,
            tables: aggregate.tables,
            rows,
            mode: aggregate.event.mode,
          });
          aggregate.guests = plan.guests;
          aggregate.tables = plan.tables;
          addAudit(
            aggregate,
            "seating.imported",
            `user:${user.id}`,
            `已匯入${plan.assignedGuestIds.length}個座位${plan.createdTables.length ? `，新增${plan.createdTables.length}張圍枱` : ""}`,
            now
          );
          return {
            assigned: plan.assignedGuestIds.length,
            createdTables: plan.createdTables,
          };
        }
      );
      res.status(201).json(response);
    })
  );

  router.get(
    "/events/:eventId/guest-roster.csv",
    route(async (req, res) => {
      const user = await authenticated(req);
      const row = await readEvent(req.params.eventId);
      requireRole(await readAccess(row, user), [
        "owner",
        "admin",
        "project_manager",
        "guest_manager",
      ]);
      const aggregate = parseAggregate(row.event_state);
      const csv = guestRosterCsv(
        aggregate.event,
        aggregate.guests,
        aggregate.tables
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="eventflow-${aggregate.event.slug}-guests.csv"`
      );
      res.send(csv);
    })
  );

  router.post(
    "/events/:eventId/merchants",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "merchant.create",
        ["owner", "admin", "project_manager"],
        async ({ aggregate, now }) => {
          assertFeatureEnabled(aggregate.event, "commerce");
          const merchant: Merchant = {
            id: randomUUID(),
            tenantId: aggregate.event.tenantId,
            eventId: aggregate.event.id,
            name: text(body.name, "商戶名稱", { max: 200 })!,
            active: true,
            createdAt: nowIso(now),
          };
          aggregate.merchants.push(merchant);
          addAudit(
            aggregate,
            "merchant.created",
            `user:${user.id}`,
            "已建立商戶",
            now
          );
          return merchant;
        }
      );
      res.status(201).json(response);
    })
  );

  router.patch(
    "/events/:eventId/merchants/:id",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "merchant.update",
        ["owner", "admin", "project_manager"],
        async ({ aggregate, now }) => {
          assertFeatureEnabled(aggregate.event, "commerce");
          if (body.active === undefined)
            throw new DomainError(
              400,
              "VALIDATION_ERROR",
              "請提供商戶啟用狀態"
            );
          const index = aggregate.merchants.findIndex(
            merchant => merchant.id === req.params.id
          );
          if (index < 0)
            throw new DomainError(404, "MERCHANT_NOT_FOUND", "找不到商戶");
          const merchant = {
            ...aggregate.merchants[index],
            active: bool(body.active, "商戶啟用狀態"),
          };
          aggregate.merchants[index] = merchant;
          addAudit(
            aggregate,
            "merchant.updated",
            `user:${user.id}`,
            "已更新商戶狀態",
            now
          );
          return merchant;
        }
      );
      res.json(response);
    })
  );

  router.post(
    "/events/:eventId/receipts",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "receipt.issue",
        ["owner", "admin", "project_manager", "merchant"],
        async ({ connection, aggregate, access, now }) => {
          assertFeatureEnabled(aggregate.event, "commerce");
          const merchantId = text(body.merchantId, "商戶", { max: 36 })!;
          ensureMerchantScope(access, merchantId);
          const merchant = aggregate.merchants.find(
            item => item.id === merchantId
          );
          if (!merchant || !merchant.active)
            throw new DomainError(
              409,
              "MERCHANT_INACTIVE",
              "商戶不存在或未啟用"
            );
          const amountCents = integerCents(body.amountCents);
          const reference = text(body.reference, "交易參考", { max: 200 })!;
          if (
            aggregate.receipts.some(
              receipt =>
                receipt.merchantId === merchantId &&
                receipt.reference === reference
            )
          )
            throw new DomainError(
              409,
              "RECEIPT_REFERENCE_EXISTS",
              "此商戶交易參考已存在"
            );
          const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          const receipt: Receipt = {
            id: randomUUID(),
            tenantId: aggregate.event.tenantId,
            eventId: aggregate.event.id,
            merchantId,
            amountCents,
            feeCents: feeForCents(amountCents),
            status: "valid",
            guestId: null,
            claimedAt: null,
            createdAt: nowIso(now),
            expiresAt: nowIso(expires),
            reference,
            ruleVersion: aggregate.event.ruleVersion,
            thresholdCents: aggregate.event.thresholdCents,
            accumulation: aggregate.event.accumulation,
            chances: 0,
          };
          aggregate.receipts.push(receipt);
          const issued = await insertInvite(connection, {
            eventId: aggregate.event.id,
            kind: "receipt",
            expiresAt: expires,
            now,
          });
          // Bind the capability to this receipt without placing the raw token in aggregate state.
          await connection.execute(
            "UPDATE ef_invites SET guest_id = ? WHERE token_hash = ?",
            [receipt.id, sha256(issued.token)]
          );
          addAudit(
            aggregate,
            "receipt.issued",
            `user:${user.id}`,
            "已發出消費憑證",
            now
          );
          return {
            receipt,
            token: issued.token,
            path: receiptTokenPath(issued.token),
            possibleChances: receiptChances(
              amountCents,
              receipt.thresholdCents
            ),
          };
        }
      );
      res.status(201).json(response);
    })
  );

  router.post(
    "/events/:eventId/receipts/:id/void",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "receipt.void",
        ["owner", "admin", "project_manager"],
        async ({ aggregate, now }) => {
          assertFeatureEnabled(aggregate.event, "commerce");
          const index = aggregate.receipts.findIndex(
            receipt => receipt.id === req.params.id
          );
          if (index < 0)
            throw new DomainError(404, "RECEIPT_NOT_FOUND", "找不到消費憑證");
          const current = aggregate.receipts[index];
          if (current.status === "void") return current;
          const reason = text(body.reason, "作廢原因", { max: MAX_TEXT })!;
          const frozenInDraw = receiptInAnyDrawSnapshot(
            current.id,
            aggregate.draws
          );
          const voided: Receipt = {
            ...current,
            status: "void",
            voidReason: reason,
            ...(frozenInDraw ? { drawException: true } : {}),
          };
          aggregate.receipts[index] = voided;
          if (current.guestId && !frozenInDraw) {
            const delta = voidLedgerAdjustment(
              aggregate.receipts,
              aggregate.ledger,
              current.guestId,
              current
            );
            recordLedger(aggregate, {
              guestId: current.guestId,
              receiptId: current.id,
              ruleVersion: current.ruleVersion,
              delta,
              kind: "void_adjustment",
              now,
            });
            updateGuestChances(aggregate, current.guestId);
          }
          // Original fee is retained for audit; void status offsets it in settlement.
          addAudit(
            aggregate,
            "receipt.voided",
            `user:${user.id}`,
            frozenInDraw
              ? "已作廢憑證；抽獎快照已保留例外"
              : "已作廢憑證並調整未參與權益",
            now
          );
          return voided;
        }
      );
      res.json(response);
    })
  );

  router.get(
    "/events/:eventId/settlements",
    route(async (req, res) => {
      const user = await authenticated(req);
      const row = await readEvent(req.params.eventId);
      requireRole(await readAccess(row, user), [
        "owner",
        "admin",
        "project_manager",
      ]);
      const aggregate = parseAggregate(row.event_state);
      assertFeatureEnabled(aggregate.event, "commerce");
      const settlements = aggregate.merchants.map(merchant =>
        merchantSettlement(merchant, aggregate.receipts, aggregate.payments)
      );
      res.json(settlements);
    })
  );

  router.post(
    "/events/:eventId/payments",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "payment.record",
        ["owner", "admin", "project_manager"],
        async ({ aggregate, now }) => {
          assertFeatureEnabled(aggregate.event, "commerce");
          const merchantId = text(body.merchantId, "商戶", { max: 36 })!;
          if (!aggregate.merchants.some(merchant => merchant.id === merchantId))
            throw new DomainError(404, "MERCHANT_NOT_FOUND", "找不到商戶");
          const reference = text(body.reference, "收款參考", { max: 200 })!;
          if (
            aggregate.payments.some(
              payment =>
                payment.merchantId === merchantId &&
                payment.reference === reference
            )
          )
            throw new DomainError(
              409,
              "PAYMENT_REFERENCE_EXISTS",
              "此商戶收款參考已存在"
            );
          const payment: Payment = {
            id: randomUUID(),
            merchantId,
            amountCents: integerCents(body.amountCents),
            reference,
            createdAt: nowIso(now),
          };
          aggregate.payments.push(payment);
          addAudit(
            aggregate,
            "payment.recorded",
            `user:${user.id}`,
            "已記錄商戶收款",
            now
          );
          return payment;
        }
      );
      res.status(201).json(response);
    })
  );

  router.get(
    "/events/:eventId/export",
    route(async (req, res) => {
      const user = await authenticated(req);
      const row = await readEvent(req.params.eventId);
      requireRole(await readAccess(row, user), [
        "owner",
        "admin",
        "project_manager",
      ]);
      const aggregate = parseAggregate(row.event_state);
      assertFeatureEnabled(aggregate.event, "commerce");
      const csv = accountingCsv(
        aggregate.merchants,
        aggregate.receipts,
        aggregate.payments
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="eventflow-${aggregate.event.id}.csv"`
      );
      res.send(csv);
    })
  );

  router.post(
    "/events/:eventId/prizes",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "prize.create",
        ["owner", "admin", "project_manager"],
        async ({ aggregate, now }) => {
          assertFeatureEnabled(aggregate.event, "draw");
          const prize: Prize = {
            id: randomUUID(),
            name: text(body.name, "獎項名稱", { max: 200 })!,
            drawId: null,
          };
          aggregate.prizes.push(prize);
          addAudit(
            aggregate,
            "prize.created",
            `user:${user.id}`,
            "已建立獎項",
            now
          );
          return prize;
        }
      );
      res.status(201).json(response);
    })
  );

  router.post(
    "/events/:eventId/draws",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      const body = bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "draw.create",
        ["owner", "admin", "project_manager", "draw"],
        async ({ aggregate, now }) => {
          assertFeatureEnabled(aggregate.event, "draw");
          const prizeId = text(body.prizeId, "獎項", { max: 36 })!;
          const prizeIndex = aggregate.prizes.findIndex(
            prize => prize.id === prizeId
          );
          if (prizeIndex < 0)
            throw new DomainError(404, "PRIZE_NOT_FOUND", "找不到獎項");
          const prize = aggregate.prizes[prizeIndex];
          if (prize.drawId)
            throw new DomainError(
              409,
              "PRIZE_ALREADY_DRAWN",
              "此獎項已完成抽獎"
            );
          if (aggregate.draws.some(draw => !draw.revealedAt))
            throw new DomainError(
              409,
              "DRAW_IN_PROGRESS",
              "請先完成本輪揭曉，再開始下一輪抽獎"
            );
          const snapshot = buildDrawSnapshot(
            aggregate,
            aggregate.event.excludeWinners
          );
          const picked = selectWeightedWinner(snapshot);
          const winner = aggregate.guests.find(
            guest => guest.id === picked.winnerGuestId
          );
          if (!winner)
            throw new DomainError(
              503,
              "DRAW_STATE_INVALID",
              "抽獎快照資料不完整"
            );
          const tableNumber = winner.tableId
            ? (aggregate.tables.find(table => table.id === winner.tableId)
                ?.number ?? null)
            : null;
          const draw: InternalDraw = {
            id: randomUUID(),
            prizeId: prize.id,
            prizeName: prize.name,
            winner: {
              id: winner.id,
              name: winner.name,
              ticket: winner.ticket,
              tableNumber,
            },
            winnerGuestId: winner.id,
            totalChances: picked.totalChances,
            eligibleGuests: picked.eligibleGuests,
            createdAt: nowIso(now),
            revealedAt: null,
            snapshot,
          };
          aggregate.draws.push(draw);
          aggregate.prizes[prizeIndex] = { ...prize, drawId: draw.id };
          addAudit(
            aggregate,
            "draw.created",
            `user:${user.id}`,
            "已以安全快照選出得獎者",
            now
          );
          return drawDto(draw);
        }
      );
      res.status(201).json(response);
    })
  );

  router.post(
    "/events/:eventId/draws/:id/reveal",
    route(async (req, res) => {
      const user = await authenticatedMutation(req);
      bodyObject(req);
      const response = await withLockedStaffEvent(
        req,
        user,
        req.params.eventId,
        "draw.reveal",
        ["owner", "admin", "project_manager", "draw"],
        async ({ aggregate, now }) => {
          assertFeatureEnabled(aggregate.event, "draw");
          const index = aggregate.draws.findIndex(
            draw => draw.id === req.params.id
          );
          if (index < 0)
            throw new DomainError(404, "DRAW_NOT_FOUND", "找不到抽獎紀錄");
          const draw = aggregate.draws[index];
          if (!draw.revealedAt) {
            draw.revealedAt = nowIso(now);
            aggregate.draws[index] = draw;
            addAudit(
              aggregate,
              "draw.revealed",
              `user:${user.id}`,
              "已公開既有抽獎結果",
              now
            );
          }
          return drawDto(draw);
        },
        { idempotent: false }
      );
      res.json(response);
    })
  );

  router.get(
    "/public/events/:slug",
    route(async (req, res) => {
      const slug = text(req.params.slug, "活動識別", { max: 160 })!;
      const rows = await readRows<PublicEventRow>(
        "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE slug = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) LIMIT 1",
        [slug]
      );
      const row = rows[0];
      if (!row || row.owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
      res.json(basicEvent(parseAggregate(row.event_state).event));
    })
  );

  router.post(
    "/public/events/:slug/quick-names",
    route(async (req, res) => {
      assertSameOriginJson(req);
      assertRateLimit("public-roster-names", clientKey(req), 3000, 10 * 60 * 1000);
      await readParticipantSession(req);
      bodyObject(req);
      const slug = text(req.params.slug, "活動識別", { max: 160 })!;
      const rows = await readRows<PublicEventRow>(
        "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE slug = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) LIMIT 1", [slug]
      );
      if (!rows.length || rows[0].owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
      res.json(quickGuestNames(quickAggregate(rows[0])));
    })
  );

  router.post(
    "/public/events/:slug/quick-search",
    route(async (req, res) => {
      assertSameOriginJson(req);
      assertRateLimit("public-roster-search", clientKey(req), 6000, 10 * 60 * 1000);
      await readParticipantSession(req);
      const body = bodyObject(req);
      const slug = text(req.params.slug, "活動識別", { max: 160 })!;
      const rows = await readRows<PublicEventRow>(
        "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE slug = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) LIMIT 1", [slug]
      );
      if (!rows.length || rows[0].owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
      res.json(quickGuestSearch(quickAggregate(rows[0]), body.name));
    })
  );

  router.post(
    "/public/events/:slug/roster-search",
    route(async (req, res) => {
      assertSameOriginJson(req);
      // Read-only name lookup. Venue guests often share one Wi-Fi/proxy address.
      assertRateLimit("public-roster-search", clientKey(req), 6000, 10 * 60 * 1000);
      await readParticipantSession(req);
      const body = bodyObject(req);
      // No visitor personal data is collected by a name lookup; consent is
      // still required by /register before a phone number is submitted.
      const slug = text(req.params.slug, "活動識別", { max: 160 })!;
      const rows = await readRows<PublicEventRow>(
        "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE slug = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) LIMIT 1", [slug]
      );
      if (!rows.length || rows[0].owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
      res.json(searchRosterGuests(parseAggregate(rows[0].event_state), rosterSearchInput(body)));
    })
  );

  router.post(
    "/public/events/:slug/roster-names",
    route(async (req, res) => {
      assertSameOriginJson(req);
      assertRateLimit("public-roster-names", clientKey(req), 3000, 10 * 60 * 1000);
      await readParticipantSession(req);
      bodyObject(req);
      const slug = text(req.params.slug, "活動識別", { max: 160 })!;
      const rows = await readRows<PublicEventRow>(
        "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE slug = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) LIMIT 1",
        [slug]
      );
      if (!rows.length || rows[0].owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
      res.json(listRosterGuestNames(parseAggregate(rows[0].event_state)));
    })
  );

  router.post(
    "/public/events/:slug/roster-match",
    route(async(req,res)=>{
      assertSameOriginJson(req);
      assertRateLimit("public-roster-match",clientKey(req),1200,10*60*1000);
      await readParticipantSession(req);
      const body=bodyObject(req);
      if(body.consent!==true)throw new DomainError(400,"CONSENT_REQUIRED","請先同意私隱說明");
      const slug=text(req.params.slug,"活動識別",{max:160})!;
      const rows=await readRows<PublicEventRow>("SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE slug = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) LIMIT 1",[slug]);
      if(!rows.length || rows[0].owner_user_id == null)throw new DomainError(404,"EVENT_NOT_FOUND","找不到活動");
      const aggregate=parseAggregate(rows[0].event_state);
      const guest=matchRosterGuest(aggregate,rosterIdentityInput(body));
      res.json(rosterMatchView(aggregate,guest));
    })
  );

  router.post(
    "/public/events/:slug/register",
    route(async (req, res) => {
      assertSameOriginJson(req);
      assertRateLimit("public-register", clientKey(req), 600, 10 * 60 * 1000);
      const participant = await readParticipantSession(req);
      const body = bodyObject(req);
      if (body.consent !== true)
        throw new DomainError(400, "CONSENT_REQUIRED", "請先同意私隱說明");
      const slug = text(req.params.slug, "活動識別", { max: 160 })!;
      const key = requireIdempotencyKey(req);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          key
        )
      ) {
        throw new DomainError(
          400,
          "INVALID_REGISTRATION_KEY",
          "登記操作憑證無效，請重新開啟登記頁。"
        );
      }
      const response = await withTransaction(async connection => {
        const [eventRows] = await connection.query<EventRow[]>(
          "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE slug = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) FOR UPDATE",
          [slug]
        );
        const row = eventRows[0];
        if (!row || row.owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
        const aggregate = body.quickRegistration === true ? quickAggregate(row) : parseAggregate(row.event_state);
        const now = new Date();
        return replayOrStore(
          connection,
          {
            eventId: row.id,
            action: "public.register",
            actorScope: participant ? `participant:${participant.id}` : `public:${sha256(key)}`,
            key,
            body,
            now,
          },
          async () => {
            if (
              !aggregate.event.registrationOpen ||
              aggregate.event.status === "closed"
            ) {
              throw new DomainError(
                403,
                "REGISTRATION_CLOSED",
                "此活動暫未開放登記"
              );
            }
            const usesRoster=aggregate.event.mode==="attendance"&&aggregate.event.rosterClaimEnabled===true;
            const usesQuick = body.quickRegistration === true;
            if (body.quickRegistration !== undefined && typeof body.quickRegistration !== "boolean")
              throw new DomainError(400, "VALIDATION_ERROR", "請重新開啟登記頁。");
            if (!usesRoster && !usesQuick && (body.confirmRoster !== undefined || body.confirmedGuestId !== undefined || body.rosterSelection !== undefined))
              throw new DomainError(400, "ROSTER_MATCH_FAILED", "未能核對預排名單，請向現場工作人員查詢。");
            let guest:Guest;
            if (usesQuick) {
              if (aggregate.event.id !== row.id || aggregate.event.tenantId !== row.tenant_id)
                throw new DomainError(503, "EVENT_STATE_UNAVAILABLE", "活動資料暫時無法安全讀取");
              const actorScope = participant ? `participant:${participant.id}` : `public:${sha256(key)}`;
              if (body.walkIn === true) {
                if (body.confirmRoster !== undefined || body.confirmedGuestId !== undefined || body.rosterSelection !== undefined)
                  throw new DomainError(400, "QUICK_MATCH_FAILED", "請重新開啟登記頁。");
                assertQuickNameIsNew(aggregate, body.name);
                let phone: string;
                try { phone = registrationPhone(body.phone); }
                catch { throw new DomainError(400, "INVALID_PHONE", "登記時請填寫本人電話。"); }
                guest = createGuest(aggregate, validateGuestInput({
                  name: body.name, phone,
                  invitedBy: text(body.invitedBy, "邀請人", { optional: true, min: 0, max: 120 }) || "",
                  note: "嘉賓以簡易入口自行登記；未安排座位，待工作人員核對。",
                }), now);
                guest.rosterClaimedAt = nowIso(now);
                guest.rosterClaimedBy = actorScope;
              } else {
                if (body.confirmRoster !== true || body.rosterSelection !== true || body.walkIn !== undefined)
                  throw new DomainError(400, "QUICK_CONFIRM_REQUIRED", "請先選擇並確認本人紀錄。");
                guest = claimQuickGuest(aggregate, { name: body.name, phone: body.phone }, {
                  confirmedGuestId: text(body.confirmedGuestId, "已確認嘉賓", { max: 80 })!, actorScope, now,
                });
                const index = aggregate.guests.findIndex(item => item.id === guest.id);
                aggregate.guests[index] = guest;
              }
            } else if(usesRoster && body.walkIn === true){
              // Fallback when the guest cannot find themself: create an unseated
              // walk-in record for staff to seat. It never claims a roster row.
              if (body.confirmRoster !== undefined || body.confirmedGuestId !== undefined || body.rosterSelection !== undefined)
                throw new DomainError(400, "ROSTER_MATCH_FAILED", "請重新開啟登記頁。");
              let phone: string;
              try { phone = registrationPhone(body.phone); }
              catch (error) { throw new DomainError(400, "INVALID_PHONE", error instanceof Error ? error.message : "電話不正確"); }
              const walkInName = text(body.name, "姓名", { max: 120 });
              if (!walkInName) throw new DomainError(400, "VALIDATION_ERROR", "請輸入姓名");
              const onList = searchRosterGuests(aggregate, { name: walkInName });
              if (onList.candidates.length > 0 || onList.requiresRefinement)
                throw new DomainError(409, "ROSTER_NAME_EXISTS", "名單上已有這個名字，請在上方點選你的名字確認座位。");
              const inviter = text(body.invitedBy, "邀請人", { max: 120 }) || "";
              const input = validateGuestInput({
                name: body.name,
                phone,
                invitedBy: inviter,
                group: "現場登記（名單找不到）",
                note: `現場自行登記：名單上找不到本人${inviter ? `；邀請人：${inviter}` : ""}；待工作人員核對及安排座位。`,
              });
              guest = createGuest(aggregate, input, now);
              guest.rosterClaimedAt = nowIso(now);
              guest.rosterClaimedBy = participant ? `participant:${participant.id}` : `public:${sha256(key)}`;
            } else if(usesRoster){
              if(body.confirmRoster!==true)throw new DomainError(400,"ROSTER_CONFIRM_REQUIRED","請先核對並確認預排座位");
              if (body.rosterSelection !== undefined && typeof body.rosterSelection !== "boolean")
                throw new DomainError(400, "ROSTER_MATCH_FAILED", "請重新查找並選擇本人紀錄。");
              const options = {confirmedGuestId:text(body.confirmedGuestId,"已確認嘉賓",{max:80})!,actorScope:participant?`participant:${participant.id}`:`public:${sha256(key)}`,now};
              guest = body.rosterSelection === true
                ? claimRosterSelectedGuest(aggregate, rosterSelectionInput(body), options)
                : claimRosterGuest(aggregate, rosterIdentityInput(body), options);
              // claimRosterGuest returns a NEW object: persist it before check-in and save.
              const index = aggregate.guests.findIndex(item => item.id === guest.id);
              aggregate.guests[index] = guest;
            }else{
              const input=publicGuestInput(body,aggregate.event);
              guest=createGuest(aggregate,input,now);
            }
            if (aggregate.event.registrationCheckIn && !guest.checkedInAt) {
              guest.checkedInAt = nowIso(now);
              addAudit(
                aggregate,
                "guest.self_checked_in",
                "public",
                "嘉賓自行登記並申報到場（非工作人員核實）",
                now
              );
            }
            const issued = await insertInvite(connection, {
              eventId: row.id,
              kind: "guest",
              guestId: guest.id,
              ...(participant
                ? { expiresAt: new Date(participant.expiresAt) }
                : usesRoster || usesQuick ? {expiresAt:new Date(now.getTime()+20*60*60*1000)} : {}),
              now,
            });
            addAudit(
              aggregate,
              usesQuick ? "guest.quick_registered" : body.walkIn === true && usesRoster ? "guest.walk_in_registered" : usesRoster ? "guest.roster_self_claimed" : "guest.public_registered",
              "public",
              usesQuick ? "嘉賓以通用簡易入口自行確認／登記（非OTP或工作人員核實，保留原到場開關）" : body.walkIn === true && usesRoster ? `名單找不到，嘉賓以現場身份自行登記：${guest.name}（待安排座位）` : usesRoster ? body.rosterSelection === true ? "嘉賓以少資料查找並自行選擇本人預排紀錄（非OTP或工作人員核實）" : "嘉賓自行核對分會／班號／邀請人並認領預排座位（非OTP或工作人員核實）" : "嘉賓已自行登記",
              now
            );
            await saveAggregate(connection, row.id, aggregate, now);
            return {
              guest:guestSelfView(guest),
              invitation: invitation(issued.token, "guest", issued.expiresAt),
            };
          }
        );
      });
      res.status(201).json(response);
    })
  );

  router.get(
    "/guest",
    route(async (req, res) => {
      const token = req.get("X-Guest-Token");
      if (!token || token.length > 512)
        throw new DomainError(401, "GUEST_UNAUTHORIZED", "請提供有效嘉賓憑證");
      assertRateLimit("guest-view", token, 60, 60 * 60 * 1000);
      const invites = await readRows<InviteRow>(
        "SELECT * FROM ef_invites WHERE token_hash = ? LIMIT 1",
        [sha256(token)]
      );
      const invite = invites[0];
      if (
        !invite ||
        invite.kind !== "guest" ||
        invite.revoked_at ||
        !invite.guest_id
      )
        throw new DomainError(401, "GUEST_UNAUTHORIZED", "請提供有效嘉賓憑證");
      assertInviteUsable(invite, new Date());
      const row = await readEvent(invite.event_id);
      const aggregate = parseAggregate(row.event_state);
      const guest = aggregate.guests.find(item => item.id === invite.guest_id);
      if (!guest || isExcludedFromEvent(aggregate.event, guest))
        throw new DomainError(401, "GUEST_UNAUTHORIZED", "請提供有效嘉賓憑證");
      const receipts = aggregate.receipts.filter(
        receipt => receipt.guestId === guest.id
      );
      const draws = aggregate.draws
        .filter(draw => Boolean(draw.revealedAt))
        .map(drawDto);
      const assignedTable = aggregate.tables.find(
        table => table.id === guest.tableId
      );
      const table = assignedTable
        ? {
            number: assignedTable.number,
            label: assignedTable.label,
            seat: guest.seat,
          }
        : null;
      res.json({
        event: basicEvent(aggregate.event),
        guest: { ...guestSelfView(guest), chances: availableChances(aggregate, guest.id) },
        table,
        receipts,
        draws,
      });
    })
  );

  router.post(
    "/guest/claim",
    route(async (req, res) => {
      assertSameOriginJson(req);
      const body = bodyObject(req);
      const guestToken = req.get("X-Guest-Token");
      if (!guestToken || guestToken.length > 512)
        throw new DomainError(401, "GUEST_UNAUTHORIZED", "請提供有效嘉賓憑證");
      assertRateLimit("guest-claim", guestToken, 20, 60 * 60 * 1000);
      const receiptToken = text(body.token, "消費憑證", { max: 512 })!;
      const key = requireIdempotencyKey(req);
      const response = await withTransaction(async connection => {
        const [guestInvites] = await connection.query<InviteRow[]>(
          "SELECT * FROM ef_invites WHERE token_hash = ? FOR UPDATE",
          [sha256(guestToken)]
        );
        const guestInvite = guestInvites[0];
        if (
          !guestInvite ||
          guestInvite.kind !== "guest" ||
          guestInvite.revoked_at ||
          !guestInvite.guest_id
        )
          throw new DomainError(
            401,
            "GUEST_UNAUTHORIZED",
            "請提供有效嘉賓憑證"
          );
        assertInviteUsable(guestInvite, new Date());
        const row = await lockedEventRow(connection, guestInvite.event_id);
        assertBoundEvent(row);
        const aggregate = parseAggregate(row.event_state);
        assertFeatureEnabled(aggregate.event, "commerce");
        const guest = aggregate.guests.find(
          item => item.id === guestInvite.guest_id
        );
        if (!guest)
          throw new DomainError(
            401,
            "GUEST_UNAUTHORIZED",
            "請提供有效嘉賓憑證"
          );
        const now = new Date();
        return replayOrStore(
          connection,
          {
            eventId: row.id,
            action: "guest.claim",
            actorScope: `guest:${guest.id}`,
            key,
            body,
            now,
          },
          async () => {
            const [receiptInvites] = await connection.query<InviteRow[]>(
              "SELECT * FROM ef_invites WHERE token_hash = ? FOR UPDATE",
              [sha256(receiptToken)]
            );
            const receiptInvite = receiptInvites[0];
            if (
              !receiptInvite ||
              receiptInvite.kind !== "receipt" ||
              !receiptInvite.guest_id
            )
              throw new DomainError(
                404,
                "RECEIPT_TOKEN_NOT_FOUND",
                "找不到有效消費憑證"
              );
            assertEventScope(aggregate.event.id, receiptInvite.event_id);
            const receiptIndex = aggregate.receipts.findIndex(
              receipt => receipt.id === receiptInvite.guest_id
            );
            if (receiptIndex < 0)
              throw new DomainError(
                503,
                "RECEIPT_STATE_INVALID",
                "消費憑證資料不完整"
              );
            const receipt = aggregate.receipts[receiptIndex];
            if (receipt.status === "void")
              throw new DomainError(409, "RECEIPT_VOID", "此消費憑證已作廢");
            if (
              receiptInvite.claimed_by_guest_id &&
              receiptInvite.claimed_by_guest_id !== guest.id
            )
              throw new DomainError(
                409,
                "RECEIPT_CLAIMED_BY_OTHER",
                "此消費憑證已由其他嘉賓領取"
              );
            if (receipt.guestId && receipt.guestId !== guest.id)
              throw new DomainError(
                409,
                "RECEIPT_CLAIMED_BY_OTHER",
                "此消費憑證已由其他嘉賓領取"
              );
            if (receipt.guestId === guest.id) {
              return {
                receipt,
                gained: 0,
                total: availableChances(aggregate, guest.id),
                alreadyClaimed: true,
              };
            }
            const expiry = iso(receiptInvite.expires_at);
            if (expiry && new Date(expiry).getTime() <= now.getTime())
              throw new DomainError(410, "RECEIPT_EXPIRED", "消費憑證已過期");
            let gained: number;
            if (receipt.accumulation === "per_transaction") {
              gained = receiptChances(
                receipt.amountCents,
                receipt.thresholdCents
              );
            } else {
              const prior = aggregate.receipts
                .filter(
                  item =>
                    item.id !== receipt.id &&
                    item.guestId === guest.id &&
                    item.status === "valid" &&
                    item.ruleVersion === receipt.ruleVersion
                )
                .reduce((sum, item) => sum + item.amountCents, 0);
              gained = cumulativeClaimDelta(
                prior,
                receipt.amountCents,
                receipt.thresholdCents
              );
            }
            const claimed: Receipt = {
              ...receipt,
              guestId: guest.id,
              claimedAt: nowIso(now),
              chances: gained,
            };
            aggregate.receipts[receiptIndex] = claimed;
            recordLedger(aggregate, {
              guestId: guest.id,
              receiptId: receipt.id,
              ruleVersion: receipt.ruleVersion,
              delta: gained,
              kind: "claim",
              now,
            });
            const updatedGuest = updateGuestChances(aggregate, guest.id);
            await connection.execute(
              "UPDATE ef_invites SET claimed_by_guest_id = ?, consumed_at = ? WHERE id = ?",
              [guest.id, sqlDate(now), receiptInvite.id]
            );
            addAudit(
              aggregate,
              "receipt.claimed",
              `guest:${guest.id}`,
              "嘉賓已領取消費憑證",
              now
            );
            await saveAggregate(connection, row.id, aggregate, now);
            return {
              receipt: claimed,
              gained,
              total: availableChances(aggregate, updatedGuest.id),
              alreadyClaimed: false,
            };
          }
        );
      });
      res.json(response);
    })
  );

  app.use("/api/eventflow", router);
}
