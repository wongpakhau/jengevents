import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import { DomainError } from "./engine";

let pool: Pool | null = null;

function databaseConfig() {
  const raw = process.env.DATABASE_URL;
  if (!raw)
    throw new DomainError(
      503,
      "DATABASE_UNAVAILABLE",
      "服務暫時無法連接資料庫"
    );
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DomainError(
      503,
      "DATABASE_UNAVAILABLE",
      "服務暫時無法連接資料庫"
    );
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new DomainError(
      503,
      "DATABASE_UNAVAILABLE",
      "服務暫時無法連接資料庫"
    );
  }
  return {
    uri: raw,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: "Z" as const,
    decimalNumbers: true,
  };
}

export function getPool(): Pool {
  if (!pool) pool = mysql.createPool(databaseConfig());
  return pool;
}

export async function withTransaction<T>(
  work: (connection: PoolConnection) => Promise<T>
): Promise<T> {
  let connection: PoolConnection | undefined;
  try {
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch {
        // The original error is safer and more useful than a rollback failure.
      }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

export async function readRows<T extends RowDataPacket>(
  sql: string,
  values: readonly unknown[] = []
): Promise<T[]> {
  try {
    const [rows] = await getPool().query<T[]>(sql, values);
    return rows;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      503,
      "DATABASE_UNAVAILABLE",
      "服務暫時無法連接資料庫"
    );
  }
}

export async function lockedEventRow(
  connection: PoolConnection,
  eventId: string
): Promise<EventRow> {
  const [rows] = await connection.query<EventRow[]>(
    "SELECT id, tenant_id, owner_user_id, event_state FROM ef_events WHERE id = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) FOR UPDATE",
    [eventId]
  );
  const row = rows[0];
  if (!row || row.owner_user_id == null) throw new DomainError(404, "EVENT_NOT_FOUND", "找不到活動");
  return row;
}

export type EventRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  owner_user_id: number | null;
  event_state: string;
};
