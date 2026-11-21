import { randomUUID } from "node:crypto";
import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { AuthenticatedUser } from "../_core/sdk";
import { DomainError } from "./engine";
import { isSystemOwner } from "./access-policy";
import { readRows, withTransaction } from "./database";
import { stableJson } from "./security";
import {
  ORGANIZATION_ID,
  EVENT_ID,
  MARKER_KEY,
  buildInitialAggregate,
  isSameEventIdentity,
} from "./positive-spring-initializer";

const CLAIM_ACTION = `pending.claim:${EVENT_ID}`;
type Org = RowDataPacket & {
  id: string;
  name: string;
  owner_user_id: number | null;
};
type Event = RowDataPacket & {
  id: string;
  tenant_id: string;
  owner_user_id: number | null;
  slug: string;
  event_state: string;
};
type Marker = RowDataPacket & { organization_id: string; event_id: string };

function requireOwner(user: AuthenticatedUser) {
  if (
    user.isCron ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    !isSystemOwner(user)
  )
    throw new DomainError(
      403,
      "OWNER_REQUIRED",
      "只有已驗證的系統擁有人可以指派"
    );
}
function conflict(): never {
  throw new DomainError(
    409,
    "PENDING_OWNERSHIP_CONFLICT",
    "待指派資料狀態不一致，未作任何變更；請聯絡操作員檢查。"
  );
}
function pristine(event: Event): boolean {
  if (!isSameEventIdentity(event)) return false;
  try {
    const expected = buildInitialAggregate();
    expected.event.slug = event.slug;
    return stableJson(JSON.parse(event.event_state)) === stableJson(expected);
  } catch {
    return false;
  }
}

/** Only the fixed initializer's pending pair is discoverable, and only by the allowlisted owner. */
export async function listPendingOwnership(user: AuthenticatedUser) {
  requireOwner(user);
  const rows = await readRows<RowDataPacket>(
    "SELECT e.id FROM ef_initialization_markers m JOIN ef_organizations o ON o.id = m.organization_id JOIN ef_events e ON e.id = m.event_id AND e.tenant_id = o.id WHERE m.marker_key = ? AND m.organization_id = ? AND m.event_id = ? AND o.owner_user_id IS NULL AND e.owner_user_id IS NULL LIMIT 1",
    [MARKER_KEY, ORGANIZATION_ID, EVENT_ID]
  );
  return rows.length
    ? [{ eventId: EVENT_ID, name: "正向春茗", date: "2027-01-31" }]
    : [];
}

/** Atomic across nodes. Only an audited previous claim by this same identity is a safe retry. */
export async function claimPendingOwnership(user: AuthenticatedUser) {
  requireOwner(user);
  return withTransaction(async (connection: PoolConnection) => {
    const [markers] = await connection.query<Marker[]>(
      "SELECT organization_id,event_id FROM ef_initialization_markers WHERE marker_key = ? FOR UPDATE",
      [MARKER_KEY]
    );
    if (
      markers.length !== 1 ||
      markers[0].organization_id !== ORGANIZATION_ID ||
      markers[0].event_id !== EVENT_ID
    )
      conflict();
    const [orgs] = await connection.query<Org[]>(
      "SELECT id,name,owner_user_id FROM ef_organizations WHERE id = ? FOR UPDATE",
      [ORGANIZATION_ID]
    );
    const [events] = await connection.query<Event[]>(
      "SELECT id,tenant_id,owner_user_id,slug,event_state FROM ef_events WHERE id = ? FOR UPDATE",
      [EVENT_ID]
    );
    const org = orgs[0],
      event = events[0];
    if (
      !org ||
      !event ||
      event.tenant_id !== org.id ||
      !isSameEventIdentity(event)
    )
      conflict();
    if (org.owner_user_id === user.id && event.owner_user_id === user.id) {
      const [audits] = await connection.query<RowDataPacket[]>(
        "SELECT id FROM ef_access_audit WHERE action = ? AND actor_user_id = ? AND target_user_id = ? LIMIT 1",
        [CLAIM_ACTION, user.id, user.id]
      );
      if (audits.length) return { eventId: EVENT_ID, alreadyAssigned: true };
      conflict();
    }
    if (
      org.owner_user_id !== null ||
      event.owner_user_id !== null ||
      org.name !== "正向春茗（籌備中）" ||
      !pristine(event)
    )
      conflict();
    // A legacy or rogue membership/invitation must not become effective after binding.
    for (const table of [
      "ef_members",
      "ef_invites",
      "ef_idempotency",
    ] as const) {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM ${table} WHERE event_id = ? LIMIT 1 FOR UPDATE`,
        [EVENT_ID]
      );
      if (rows.length) conflict();
    }
    const [otherEvents] = await connection.query<RowDataPacket[]>(
      "SELECT id FROM ef_events WHERE tenant_id = ? AND id <> ? LIMIT 1 FOR UPDATE",
      [ORGANIZATION_ID, EVENT_ID]
    );
    if (otherEvents.length) conflict();
    const [orgUpdate] = await connection.execute<ResultSetHeader>(
      "UPDATE ef_organizations SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL",
      [user.id, ORGANIZATION_ID]
    );
    if (orgUpdate.affectedRows !== 1) conflict();
    const [eventUpdate] = await connection.execute<ResultSetHeader>(
      "UPDATE ef_events SET owner_user_id = ? WHERE id = ? AND tenant_id = ? AND owner_user_id IS NULL",
      [user.id, EVENT_ID, ORGANIZATION_ID]
    );
    if (eventUpdate.affectedRows !== 1) conflict();
    await connection.execute(
      "INSERT INTO ef_access_audit (id,actor_user_id,target_user_id,action,created_at) VALUES (?,?,?,?,?)",
      [
        randomUUID(),
        user.id,
        user.id,
        CLAIM_ACTION,
        new Date().toISOString().slice(0, 23).replace("T", " "),
      ]
    );
    return { eventId: EVENT_ID, alreadyAssigned: false };
  });
}
