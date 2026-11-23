import { COOKIE_NAME } from "@shared/const";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
  }
}
export function idempotencyKey() {
  return crypto.randomUUID();
}
export function money(cents: number) {
  return new Intl.NumberFormat("zh-HK", {
    style: "currency",
    currency: "HKD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
function authHeaders(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem("manus-cookie");
    const prefix = `${COOKIE_NAME}=`;
    const pair = raw?.split(";").find(x => x.trim().startsWith(prefix));
    const token = pair?.trim().slice(prefix.length);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
export async function apiFetch(path: string, init: RequestInit = {}) {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("API 路徑不正確");
  return fetch(`/api/eventflow${path}`, {
    ...init,
    credentials: "include",
    headers: { ...authHeaders(), ...init.headers },
  });
}
async function decode<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => {
    throw new ApiError("伺服器回應格式不正確，請重新載入。", response.status);
  });
  if (!response.ok)
    throw new ApiError(
      data.error || "操作未完成，請重試。",
      response.status,
      data.code
    );
  return data as T;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string
): Promise<T> {
  return decode<T>(
    await apiFetch(path, {
      method,
      ...(method === "GET" ? { cache: "no-store" as const } : {}),
      headers: {
        ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
}
export async function apiGuest<T>(
  path: string,
  guestToken: string,
  method = "GET",
  body?: unknown,
  key?: string
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("API 路徑不正確");
  return decode<T>(
    await fetch(`/api/eventflow${path}`, {
      method,
      credentials: "include",
      ...(method === "GET" ? { cache: "no-store" as const } : {}),
      headers: {
        "X-Guest-Token": guestToken,
        ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
}
export async function apiText(path: string) {
  const response = await apiFetch(path);
  if (!response.ok) {
    await decode(response);
    throw new Error("匯出失敗");
  }
  return response.text();
}
