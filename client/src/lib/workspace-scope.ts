import type { Merchant, Role, WorkspaceState } from "@shared/eventflow";

export type SettlementSnapshotErrorAction = "clear" | "retain";

/** Stable identity for data that is safe to render in the current workspace. */
export function workspaceScopeKey(
  eventId: string,
  role: Role | null | undefined,
  merchants: readonly Pick<Merchant, "id">[] = []
) {
  const merchantFingerprint = merchants
    .map(merchant => merchant.id)
    .sort()
    .join(",");
  return `${eventId}|${role ?? "none"}|${merchantFingerprint}`;
}

export function stateScopeKey(eventId: string, state: WorkspaceState | null) {
  return workspaceScopeKey(eventId, state?.role, state?.merchants ?? []);
}

/** Only transient failures in the exact same scope may keep an old snapshot. */
export function settlementErrorAction(
  status: number | undefined,
  snapshotScope: string | null,
  currentScope: string
): SettlementSnapshotErrorAction {
  if (snapshotScope !== currentScope) return "clear";
  if (status === 401 || status === 403 || status === 404) return "clear";
  return snapshotScope ? "retain" : "clear";
}

export function apiStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}
