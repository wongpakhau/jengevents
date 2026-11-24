import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { AuthenticatedUser } from "../_core/sdk";
import type { AccessDirectory, Role } from "../../shared/eventflow";
import { isSystemOwner } from "./access-policy";
import { getPool } from "./database";

export async function systemRoleFor(
  user: AuthenticatedUser,
  connection?: PoolConnection
): Promise<"owner" | "admin" | "user"> {
  if (user.isCron) return "user";
  if (isSystemOwner(user)) return "owner";
  if (user.authProvider !== "google" || !user.emailVerified) return "user";
  const [rows] = await (connection || getPool()).query<RowDataPacket[]>(
    "SELECT user_id FROM ef_system_admins WHERE user_id = ? AND active = 1",
    [user.id]
  );
  return rows.length ? "admin" : "user";
}
export async function accessDirectory(
  canGrantSystemAdmin: boolean
): Promise<AccessDirectory> {
  const p = getPool();
  const [users] = await p.query<RowDataPacket[]>(
    "SELECT u.id,u.name,u.email,u.loginMethod AS login_method,s.active AS system_active FROM users u LEFT JOIN ef_system_admins s ON s.user_id = u.id WHERE u.loginMethod IN ('google_direct','local_password') ORDER BY u.lastSignedIn DESC"
  );
  const [members] = await p.query<RowDataPacket[]>(
    "SELECT m.id,m.event_id,m.user_id,m.role,m.merchant_id,m.active FROM ef_members m JOIN ef_events e ON e.id = m.event_id AND e.owner_user_id IS NOT NULL JOIN ef_organizations o ON o.id = e.tenant_id AND o.owner_user_id IS NOT NULL"
  );
  const [events] = await p.query<RowDataPacket[]>(
    "SELECT e.id,e.event_state FROM ef_events e JOIN ef_organizations o ON o.id = e.tenant_id AND o.owner_user_id IS NOT NULL WHERE e.owner_user_id IS NOT NULL ORDER BY e.updated_at DESC"
  );
  return {
    canGrantSystemAdmin,
    users: users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      provider: u.login_method === "local_password" ? "local" : "google",
      systemRole:
        u.login_method === "google_direct" &&
        isSystemOwner({
          email: u.email,
          authProvider: "google",
          emailVerified: true,
        })
          ? "owner"
          : u.system_active && u.login_method === "google_direct"
            ? "admin"
            : "user",
      assignments: members
        .filter(m => m.user_id === u.id)
        .map(m => ({
          memberId: m.id,
          eventId: m.event_id,
          role: m.role as Role,
          merchantId: m.merchant_id,
          active: Boolean(m.active),
        })),
    })),
    events: events.map(row => {
      const aggregate =
        typeof row.event_state === "string"
          ? JSON.parse(row.event_state)
          : row.event_state;
      return {
        id: row.id,
        name: aggregate.event.name,
        mode: aggregate.event.mode || "full",
        merchants: aggregate.merchants.map(
          (m: { id: string; name: string }) => ({ id: m.id, name: m.name })
        ),
      };
    }),
  };
}
