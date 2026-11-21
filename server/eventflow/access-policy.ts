import type { AuthenticatedUser } from "../_core/sdk";
import type { Role } from "../../shared/eventflow";

const OWNER_EMAILS = new Set([
  "pakhauwong@gmail.com",
  "mikilee1028@gmail.com",
  "yeeayeeahk@gmail.com",
  "garyyang020730@gmail.com",
]);
/** Only a verified direct Google identity is eligible; a Manus name/email is not sufficient. */
export function isSystemOwner(
  user: Pick<AuthenticatedUser, "email" | "authProvider" | "emailVerified">
): boolean {
  return (
    user.authProvider === "google" &&
    user.emailVerified === true &&
    !!user.email &&
    OWNER_EMAILS.has(user.email.trim().toLowerCase())
  );
}
export const EVENT_MANAGERS: Role[] = ["owner", "admin", "project_manager"];
export const GUEST_MANAGERS: Role[] = [...EVENT_MANAGERS, "guest_manager"];
export function roleCanManageMembers(role: Role): boolean {
  return role === "owner" || role === "admin";
}
