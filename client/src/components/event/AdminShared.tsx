import { useCallback, useRef, useState, type ReactNode } from "react";
import type { Role } from "@shared/eventflow";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { api, idempotencyKey } from "@/lib/eventflow-api";

export const managerRoles: Role[] = ["owner", "admin", "project_manager"];
export const guestManagerRoles: Role[] = [...managerRoles, "guest_manager"];
export const drawRoles: Role[] = ["owner", "admin", "project_manager", "draw"];

export function hasRole(role: Role, allowed: Role[]) {
  return allowed.includes(role);
}

export function RoleNotice({
  allowed,
  children,
}: {
  allowed: Role[];
  children?: ReactNode;
}) {
  const { state } = useWorkspace();
  if (!state || hasRole(state.role, allowed)) return null;
  return (
    <div className="mvp-role-notice" role="status">
      <strong>你目前的角色是「{roleName(state.role)}」。</strong>
      <span>{children ?? "此區內容可查看，但寫入操作會由伺服器拒絕。"}</span>
    </div>
  );
}

export function roleName(role: Role) {
  return (
    {
      owner: "擁有者",
      admin: "管理員",
      project_manager: "Project Manager",
      guest_manager: "嘉賓及圍枱管理員",
      checkin: "簽到人員",
      draw: "抽獎人員",
      merchant: "商戶人員",
    } as const
  )[role];
}

type ErrorMap = Record<string, string>;

/**
 * Keeps one idempotency key for each exact write payload until the server accepts it.
 * A failed request can therefore be retried safely without producing a second write.
 */
export function useWorkspaceMutation() {
  const { reload } = useWorkspace();
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(new Set<string>());
  const [pendingScopes, setPendingScopes] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<ErrorMap>({});

  const mutate = useCallback(
    async function mutate<T>(
      scope: string,
      path: string,
      method: "POST" | "PATCH",
      body: unknown
    ): Promise<T | undefined> {
      const operation = `${method}:${path}:${JSON.stringify(body ?? null)}`;
      if (inFlight.current.has(operation)) return undefined;

      const key = keys.current.get(operation) ?? idempotencyKey();
      keys.current.set(operation, key);
      inFlight.current.add(operation);
      setPendingScopes(current => new Set(current).add(scope));

      try {
        const result = await api<T>(path, method, body, key);
        // A successful server write is final for this key; always read the source of truth next.
        keys.current.delete(operation);
        try {
          await reload();
          setErrors(current => {
            if (!(scope in current)) return current;
            const next = { ...current };
            delete next[scope];
            return next;
          });
        } catch (reloadError) {
          setErrors(current => ({
            ...current,
            [scope]: `資料已儲存，但重新載入失敗：${messageOf(reloadError)}`,
          }));
        }
        return result;
      } catch (error) {
        setErrors(current => ({ ...current, [scope]: messageOf(error) }));
        return undefined;
      } finally {
        inFlight.current.delete(operation);
        setPendingScopes(current => {
          const next = new Set(current);
          next.delete(scope);
          return next;
        });
      }
    },
    [reload]
  );

  return {
    mutate,
    isPending: (scope: string) => pendingScopes.has(scope),
    errorFor: (scope: string) => errors[scope],
  };
}

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "操作未能完成，請稍後再試。";
}

export function invitationUrl(path: string) {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

export function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Accepts a Hong Kong dollar input and returns integer cents without float arithmetic. */
export function parseCents(value: string): number | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = Number(`${whole}${fraction}`);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatIso(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-HK", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function clampCoordinate(value: number) {
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

export function InlineError({ message }: { message?: string }) {
  return message ? (
    <p className="mvp-inline-error" role="alert">
      {message}
    </p>
  ) : null;
}
