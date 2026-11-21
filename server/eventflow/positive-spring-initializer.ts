import type { Connection, RowDataPacket } from "mysql2/promise";
import { defaultEvent, newAggregate } from "./event-defaults";

// These are entity IDs, not user IDs. Never change them for this operation.
export const ORGANIZATION_ID = "ec25a382-539e-4ef5-bb2e-6941a3398b30";
export const EVENT_ID = "a6627e4a-0492-4c0a-b6a3-8bb11cb197fb";
export const MARKER_KEY = "positive-spring-banquet-2027-01-31-v1";
export const LOCK_NAME = "eventflow-positive-spring-banquet-init-v1";

// A deliberately closed allowlist: an unfamiliar application table means we
// cannot establish that this is the specific new, empty database.
export const APP_TABLES = [
  "users",
  "ef_organizations",
  "ef_events",
  "ef_members",
  "ef_invites",
  "ef_idempotency",
  "ef_system_admins",
  "ef_access_audit",
  "ef_initialization_markers",
] as const;

type SchemaTable = RowDataPacket & {
  table_name: string;
  table_type: string;
  engine: string | null;
};
type SchemaColumn = RowDataPacket & {
  table_name: string;
  column_name: string;
  is_nullable: string;
  character_set_name: string | null;
};
type Marker = RowDataPacket & {
  organization_id: string;
  event_id: string;
};
type ExistingEvent = RowDataPacket & {
  id: string;
  tenant_id: string;
  slug: string;
  event_state: string;
};

export class InitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitializationError";
  }
}

export function buildInitialAggregate() {
  return newAggregate(
    defaultEvent({
      id: EVENT_ID,
      tenantId: ORGANIZATION_ID,
      name: "正向春茗",
      date: "2027-01-31",
      venue: "",
      mode: "full",
    })
  );
}

function sqlDate(now: Date): string {
  return now.toISOString().slice(0, 23).replace("T", " ");
}

/** Only invariant identity is compared: ordinary later changes are retained. */
export function isSameEventIdentity(row: ExistingEvent): boolean {
  try {
    const state: unknown = JSON.parse(row.event_state);
    if (!state || typeof state !== "object" || !("event" in state))
      return false;
    const aggregate = state as Record<string, unknown>;
    if (
      aggregate.version !== 1 ||
      ![
        "guests",
        "tables",
        "merchants",
        "receipts",
        "payments",
        "prizes",
        "draws",
        "ledger",
        "audit",
      ].every(field => Array.isArray(aggregate[field]))
    )
      return false;
    const event = state.event;
    if (!event || typeof event !== "object") return false;
    const info = event as Record<string, unknown>;
    return (
      row.id === EVENT_ID &&
      row.tenant_id === ORGANIZATION_ID &&
      info.id === EVENT_ID &&
      info.tenantId === ORGANIZATION_ID &&
      info.slug === row.slug
    );
  } catch {
    return false;
  }
}

/**
 * The caller owns and closes the connection. No network or DB work is done at
 * import time. The transaction never updates, repairs, or claims any row.
 */
export async function initializePositiveSpring(
  connection: Connection,
  now: Date = new Date()
): Promise<"created" | "already_initialized"> {
  const [locks] = await connection.execute<RowDataPacket[]>(
    "SELECT GET_LOCK(?, ?) AS acquired",
    [LOCK_NAME, 10]
  );
  if (locks[0]?.acquired !== 1)
    throw new InitializationError("無法取得初始化鎖，請稍後重試。");

  let inTransaction = false;
  try {
    // Also avoids server-side conversion of Chinese text to a legacy charset.
    await connection.execute("SET NAMES utf8mb4");
    // Managed MySQL-compatible TiDB does not support SERIALIZABLE. The caller
    // must stop all non-cooperating application writers during initialization.
    await connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();
    inTransaction = true;

    const [tables] = await connection.execute<SchemaTable[]>(
      "SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME = ? OR LEFT(TABLE_NAME, 3) = ?)",
      ["users", "ef_"]
    );
    const tableMap = new Map(tables.map(table => [table.table_name, table]));
    for (const name of APP_TABLES) {
      const table = tableMap.get(name);
      if (
        !table ||
        table.table_type !== "BASE TABLE" ||
        table.engine?.toLowerCase() !== "innodb"
      ) {
        throw new InitializationError(
          "必要資料表不存在或不是 InnoDB；請檢查 migration 與資料庫設定。"
        );
      }
    }
    const [columns] = await connection.execute<SchemaColumn[]>(
      "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable, CHARACTER_SET_NAME AS character_set_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = ? AND COLUMN_NAME IN (?, ?)) OR (TABLE_NAME = ? AND COLUMN_NAME IN (?, ?)))",
      [
        "ef_organizations",
        "owner_user_id",
        "name",
        "ef_events",
        "owner_user_id",
        "event_state",
      ]
    );
    const column = (table: string, name: string) =>
      columns.find(c => c.table_name === table && c.column_name === name);
    if (
      column("ef_organizations", "owner_user_id")?.is_nullable !== "YES" ||
      column("ef_events", "owner_user_id")?.is_nullable !== "YES"
    ) {
      throw new InitializationError(
        "擁有人欄位尚未允許 NULL；請先由授權操作員套用 migration。"
      );
    }
    for (const [table, name] of [
      ["ef_organizations", "name"],
      ["ef_events", "event_state"],
    ] as const) {
      if (
        column(table, name)?.character_set_name?.toLowerCase() !== "utf8mb4"
      ) {
        throw new InitializationError(
          "活動文字欄位必須使用 utf8mb4；請先檢查資料庫字元集。"
        );
      }
    }

    const [markers] = await connection.execute<Marker[]>(
      "SELECT organization_id,event_id FROM ef_initialization_markers WHERE marker_key = ? FOR UPDATE",
      [MARKER_KEY]
    );
    if (markers.length) {
      const marker = markers[0]!;
      if (
        marker.organization_id !== ORGANIZATION_ID ||
        marker.event_id !== EVENT_ID
      ) {
        throw new InitializationError("初始化標記識別碼不符；未作任何變更。");
      }
      const [organizations] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM ef_organizations WHERE id = ? FOR UPDATE",
        [ORGANIZATION_ID]
      );
      const [events] = await connection.execute<ExistingEvent[]>(
        "SELECT id,tenant_id,slug,event_state FROM ef_events WHERE id = ? FOR UPDATE",
        [EVENT_ID]
      );
      if (
        organizations.length !== 1 ||
        events.length !== 1 ||
        !isSameEventIdentity(events[0]!)
      ) {
        throw new InitializationError(
          "初始化標記與現有資料不一致；未作任何修復或變更。"
        );
      }
      await connection.commit();
      inTransaction = false;
      return "already_initialized";
    }

    if (
      tables.some(
        table =>
          !APP_TABLES.includes(table.table_name as (typeof APP_TABLES)[number])
      )
    ) {
      throw new InitializationError(
        "發現未識別的應用程式資料表；拒絕在不明資料庫初始化。"
      );
    }
    // Identifiers come from the hard-coded allowlist. The named lock only
    // coordinates cooperating initializers; the caller must stop all other
    // writers because REPEATABLE READ does not guarantee empty-table gap locks
    // on every MySQL-compatible backend.
    for (const table of APP_TABLES) {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM \`${table}\` LIMIT 1 FOR UPDATE`
      );
      if (rows.length) {
        throw new InitializationError(
          `資料庫並非全新空庫（${table} 非空）；未作任何變更。`
        );
      }
    }

    const aggregate = buildInitialAggregate();
    const timestamp = sqlDate(now);
    await connection.execute(
      "INSERT INTO ef_organizations (id,owner_user_id,name,created_at) VALUES (?,?,?,?)",
      [ORGANIZATION_ID, null, "正向春茗（籌備中）", timestamp]
    );
    await connection.execute(
      "INSERT INTO ef_events (id,tenant_id,owner_user_id,slug,event_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [
        EVENT_ID,
        ORGANIZATION_ID,
        null,
        aggregate.event.slug,
        JSON.stringify(aggregate),
        timestamp,
        timestamp,
      ]
    );
    await connection.execute(
      "INSERT INTO ef_initialization_markers (marker_key,organization_id,event_id,created_at) VALUES (?,?,?,?)",
      [MARKER_KEY, ORGANIZATION_ID, EVENT_ID, timestamp]
    );
    await connection.commit();
    inTransaction = false;
    return "created";
  } catch (error) {
    if (inTransaction) {
      try {
        await connection.rollback();
      } catch {
        // Keep the original error; the caller must close the connection.
      }
    }
    throw error;
  } finally {
    try {
      await connection.execute("SELECT RELEASE_LOCK(?) AS released", [
        LOCK_NAME,
      ]);
    } catch {
      // Connection closure also releases a connection-scoped advisory lock.
    }
  }
}
