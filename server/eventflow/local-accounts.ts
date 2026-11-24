import { randomUUID } from "node:crypto";
import type { Router, Request, Response } from "express";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { LocalAccount } from "../../shared/local-login";
import {
  memberCodeOf,
  normalizeMemberCode,
  type Guest,
} from "../../shared/eventflow";
import type { AuthenticatedUser } from "../_core/sdk";
import * as db from "../db";
import {
  hashPassword,
  localOpenId,
  validatePassword,
  validateUsername,
  type LocalAccountRow,
} from "../_core/localAuth";
import { getPool, readRows, withTransaction } from "./database";
import { DomainError } from "./engine";
import { systemRoleFor } from "./system-access";
import { requireIdempotencyKey } from "./security";

const STAFF_ROLES = [
  "admin",
  "project_manager",
  "guest_manager",
  "checkin",
  "draw",
  "merchant",
] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

type Deps = {
  authenticated: (req: Request) => Promise<AuthenticatedUser>;
  authenticatedMutation: (req: Request) => Promise<AuthenticatedUser>;
  bodyObject: (req: Request) => Record<string, unknown>;
  route: (
    handler: (req: Request, res: Response) => Promise<void>
  ) => (req: Request, res: Response) => void;
  replayOrStore: <T>(
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
  ) => Promise<T>;
  sqlDate: (value: Date) => string;
};

type EventStateRow = RowDataPacket & {
  id: string;
  owner_user_id: number | null;
  event_state: string;
};

type ParsedEvent = {
  id: string;
  name: string;
  mode: string;
  merchants: { id: string; name: string; active: boolean }[];
  guests: Pick<
    Guest,
    "id" | "name" | "ticket" | "memberCode" | "excludedFromEvent"
  >[];
};

function parseEvent(row: EventStateRow): ParsedEvent | null {
  try {
    const state = JSON.parse(row.event_state) as {
      event?: { id?: string; name?: string; mode?: string };
      merchants?: { id: string; name: string; active: boolean }[];
      guests?: ParsedEvent["guests"];
    };
    if (!state?.event?.name) return null;
    return {
      id: row.id,
      name: state.event.name,
      mode: state.event.mode ?? "full",
      merchants: state.merchants ?? [],
      guests: state.guests ?? [],
    };
  } catch {
    return null;
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function requireSystemManager(
  user: AuthenticatedUser
): Promise<"owner" | "admin"> {
  const role = await systemRoleFor(user);
  if (role === "user")
    throw new DomainError(
      403,
      "FORBIDDEN",
      "只有系統擁有人或系統管理員可以管理登入帳號"
    );
  return role;
}

async function loadEvents(): Promise<Map<string, ParsedEvent>> {
  const rows = await readRows<EventStateRow>(
    "SELECT e.id,e.owner_user_id,e.event_state FROM ef_events e JOIN ef_organizations o ON o.id = e.tenant_id AND o.owner_user_id IS NOT NULL WHERE e.owner_user_id IS NOT NULL ORDER BY e.updated_at DESC"
  );
  const events = new Map<string, ParsedEvent>();
  for (const row of rows) {
    const parsed = parseEvent(row);
    if (parsed) events.set(parsed.id, parsed);
  }
  return events;
}

function accountDto(
  row: LocalAccountRow,
  events: Map<string, ParsedEvent>,
  members: RowDataPacket[]
): LocalAccount {
  const event = row.event_id ? events.get(row.event_id) : undefined;
  const guest = event?.guests.find(item => item.id === row.guest_id);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    kind: row.kind,
    active: Boolean(row.active),
    userId: row.user_id,
    eventId: row.event_id,
    eventName: event?.name ?? null,
    guestId: row.guest_id,
    guestName: guest?.name ?? null,
    memberCode: guest ? memberCodeOf(guest) : null,
    assignments:
      row.user_id === null
        ? []
        : members
            .filter(member => member.user_id === row.user_id && member.active)
            .map(member => {
              const memberEvent = events.get(String(member.event_id));
              return {
                eventId: String(member.event_id),
                eventName: memberEvent?.name ?? "",
                role: String(member.role),
                merchantId: member.merchant_id ?? null,
                merchantName:
                  memberEvent?.merchants.find(
                    item => item.id === member.merchant_id
                  )?.name ?? null,
              };
            }),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    lastLoginAt: iso(row.last_login_at),
  };
}

async function listAccounts(): Promise<LocalAccount[]> {
  const [rows, events, members] = await Promise.all([
    readRows<LocalAccountRow>(
      "SELECT * FROM ef_local_accounts ORDER BY created_at DESC"
    ),
    loadEvents(),
    readRows<RowDataPacket>(
      "SELECT m.event_id,m.user_id,m.role,m.merchant_id,m.active FROM ef_members m"
    ),
  ]);
  return rows.map(row => accountDto(row, events, members));
}

/**
 * Username/password accounts created by system owners/admins so that staff,
 * merchants and members can sign in without Google for the live rehearsal.
 */
export function registerLocalAccountRoutes(router: Router, deps: Deps): void {
  router.get(
    "/system/local-accounts",
    deps.route(async (req, res) => {
      const user = await deps.authenticated(req);
      await requireSystemManager(user);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ accounts: await listAccounts() });
    })
  );

  router.post(
    "/system/local-accounts",
    deps.route(async (req, res) => {
      const user = await deps.authenticatedMutation(req);
      await requireSystemManager(user);
      const body = deps.bodyObject(req);
      const key = requireIdempotencyKey(req);
      const username = validateUsername(body.username);
      const password = validatePassword(body.password);
      const displayName =
        typeof body.displayName === "string" && body.displayName.trim()
          ? body.displayName.trim().slice(0, 120)
          : username;
      const kind = body.kind === "member" ? "member" : "staff";
      const eventId =
        typeof body.eventId === "string" && body.eventId.trim()
          ? body.eventId.trim()
          : null;
      const role =
        typeof body.role === "string" && body.role
          ? (body.role as StaffRole)
          : null;
      if (role && !STAFF_ROLES.includes(role))
        throw new DomainError(400, "VALIDATION_ERROR", "不能指派此角色");
      if (kind === "member" && !eventId)
        throw new DomainError(400, "VALIDATION_ERROR", "會員帳號必須指定活動");
      if (role && !eventId)
        throw new DomainError(
          400,
          "VALIDATION_ERROR",
          "指派角色時必須指定活動"
        );

      const now = new Date();
      const result = await withTransaction(async connection => {
        const [existing] = await connection.query<RowDataPacket[]>(
          "SELECT id FROM ef_local_accounts WHERE username = ? LIMIT 1",
          [username]
        );
        let event: ParsedEvent | null = null;
        if (eventId) {
          const [rows] = await connection.query<EventStateRow[]>(
            "SELECT id,owner_user_id,event_state FROM ef_events WHERE id = ? AND owner_user_id IS NOT NULL LIMIT 1 FOR UPDATE",
            [eventId]
          );
          event = rows[0] ? parseEvent(rows[0]) : null;
          if (!event)
            throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
        }
        let guest: ParsedEvent["guests"][number] | undefined;
        if (kind === "member" && event) {
          if (typeof body.guestId === "string" && body.guestId) {
            guest = event.guests.find(item => item.id === body.guestId);
          } else {
            const code = normalizeMemberCode(body.memberCode);
            if (!code)
              throw new DomainError(
                400,
                "VALIDATION_ERROR",
                "請選擇嘉賓或輸入有效會員碼"
              );
            guest = event.guests.find(item => memberCodeOf(item) === code);
          }
          if (!guest)
            throw new DomainError(404, "GUEST_NOT_FOUND", "找不到此活動的嘉賓");
          if (event.mode === "attendance" && guest.excludedFromEvent === true)
            throw new DomainError(
              409,
              "GUEST_EXCLUDED",
              "此嘉賓紀錄保留但不參會"
            );
        }
        let merchantId: string | null = null;
        if (role === "merchant" && event) {
          merchantId =
            typeof body.merchantId === "string" ? body.merchantId.trim() : "";
          if (!event.merchants.some(m => m.id === merchantId && m.active))
            throw new DomainError(
              400,
              "MERCHANT_REQUIRED",
              "必須指定本活動的有效商戶"
            );
        }
        if (
          role &&
          event &&
          event.mode === "attendance" &&
          (role === "merchant" || role === "draw")
        )
          throw new DomainError(
            409,
            "FEATURE_DISABLED",
            "此典禮不使用商戶或抽獎角色"
          );

        return deps.replayOrStore(
          connection,
          {
            eventId: "system-access",
            action: "local-account.create",
            actorScope: `user:${user.id}`,
            key,
            body: { ...body, password: "[redacted]" },
            now,
          },
          async () => {
            if (existing[0])
              throw new DomainError(
                409,
                "USERNAME_TAKEN",
                "此帳號名稱已被使用，請改用其他名稱"
              );
            const id = randomUUID();
            const passwordHash = await hashPassword(password);
            let userId: number | null = null;
            if (kind === "staff") {
              const openId = localOpenId(id);
              await db.upsertUser({
                openId,
                name: displayName,
                loginMethod: "local_password",
                role: "user",
                lastSignedIn: now,
              });
              const created = await db.getUserByOpenId(openId);
              if (!created)
                throw new DomainError(
                  503,
                  "LOCAL_AUTH_UNAVAILABLE",
                  "暫時無法建立帳號，請稍後再試"
                );
              userId = created.id;
            }
            await connection.execute(
              "INSERT INTO ef_local_accounts (id,username,password_hash,display_name,kind,user_id,event_id,guest_id,active,created_by,created_at,updated_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,NULL)",
              [
                id,
                username,
                passwordHash,
                displayName,
                kind,
                userId,
                kind === "member" ? eventId : null,
                kind === "member" ? (guest?.id ?? null) : null,
                user.id,
                deps.sqlDate(now),
                deps.sqlDate(now),
              ]
            );
            if (kind === "staff" && role && event && userId !== null) {
              await connection.execute(
                "INSERT INTO ef_members (id,event_id,user_id,name,role,merchant_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),role=VALUES(role),merchant_id=VALUES(merchant_id),active=1,updated_at=VALUES(updated_at)",
                [
                  randomUUID(),
                  event.id,
                  userId,
                  displayName,
                  role,
                  merchantId,
                  deps.sqlDate(now),
                  deps.sqlDate(now),
                ]
              );
            }
            await connection.execute(
              "INSERT INTO ef_access_audit (id,actor_user_id,target_user_id,action,created_at) VALUES (?,?,?,?,?)",
              [
                randomUUID(),
                user.id,
                userId ?? user.id,
                `local_account.created:${kind}`,
                deps.sqlDate(now),
              ]
            );
            return { id };
          }
        );
      });
      const accounts = await listAccounts();
      res.status(201).json({
        account: accounts.find(item => item.id === result.id) ?? null,
        accounts,
      });
    })
  );

  router.patch(
    "/system/local-accounts/:id",
    deps.route(async (req, res) => {
      const user = await deps.authenticatedMutation(req);
      await requireSystemManager(user);
      const body = deps.bodyObject(req);
      const id = String(req.params.id);
      const updates: string[] = [];
      const params: unknown[] = [];
      if (body.password !== undefined) {
        updates.push("password_hash = ?");
        params.push(await hashPassword(validatePassword(body.password)));
      }
      if (body.active !== undefined) {
        if (typeof body.active !== "boolean")
          throw new DomainError(400, "VALIDATION_ERROR", "啟用狀態不正確");
        updates.push("active = ?");
        params.push(body.active ? 1 : 0);
      }
      if (body.displayName !== undefined) {
        if (
          typeof body.displayName !== "string" ||
          !body.displayName.trim() ||
          body.displayName.length > 120
        )
          throw new DomainError(400, "VALIDATION_ERROR", "顯示名稱不正確");
        updates.push("display_name = ?");
        params.push(body.displayName.trim());
      }
      if (updates.length === 0)
        throw new DomainError(400, "VALIDATION_ERROR", "沒有可更新的資料");
      const now = new Date();
      updates.push("updated_at = ?");
      params.push(deps.sqlDate(now));
      const [result] = await getPool().execute<RowDataPacket[]>(
        `UPDATE ef_local_accounts SET ${updates.join(", ")} WHERE id = ?`,
        [...params, id]
      );
      if ((result as unknown as { affectedRows?: number }).affectedRows === 0)
        throw new DomainError(404, "ACCOUNT_NOT_FOUND", "找不到此帳號");
      if (body.displayName !== undefined) {
        const rows = await readRows<LocalAccountRow>(
          "SELECT * FROM ef_local_accounts WHERE id = ? LIMIT 1",
          [id]
        );
        const account = rows[0];
        if (account?.user_id !== null && account?.user_id !== undefined)
          await db.upsertUser({
            openId: localOpenId(account.id),
            name: account.display_name,
          });
      }
      const accounts = await listAccounts();
      res.json({
        account: accounts.find(item => item.id === id) ?? null,
        accounts,
      });
    })
  );
}
