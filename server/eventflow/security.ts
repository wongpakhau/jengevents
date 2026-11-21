import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Request } from "express";
import { DomainError } from "./engine";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

function encryptionKey(): Buffer {
  const secret = process.env.MANUS_JWT_SECRET;
  if (!secret)
    throw new DomainError(
      503,
      "SECURE_STORAGE_UNAVAILABLE",
      "服務暫時無法安全處理憑證"
    );
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Encrypts idempotent responses that may contain one-time capability tokens. */
export function encryptSensitiveJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSensitiveJson<T>(value: string): T {
  try {
    const [ivEncoded, tagEncoded, encryptedEncoded] = value.split(".");
    if (!ivEncoded || !tagEncoded || !encryptedEncoded)
      throw new Error("invalid ciphertext");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivEncoded, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encryptedEncoded, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      503,
      "SECURE_STORAGE_UNAVAILABLE",
      "服務暫時無法安全讀取先前回覆"
    );
  }
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter(key => object[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

export function requestHash(body: unknown): string {
  return sha256(stableJson(body));
}

export function requireIdempotencyKey(req: Request): string {
  const key = req.get("Idempotency-Key");
  if (!key || key.length < 8 || key.length > 200) {
    throw new DomainError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "請提供有效的 Idempotency-Key"
    );
  }
  return key;
}

function firstHeader(value: string | undefined): string {
  return (value ?? "").split(",")[0]?.trim() ?? "";
}

/**
 * Mutations are JSON-only and reject browser cross-origin requests.  A missing
 * Origin is deliberately allowed for authenticated CLI/service callers.
 */
export function assertSameOriginJson(req: Request): void {
  const contentType = req.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new DomainError(
      415,
      "JSON_REQUIRED",
      "請求必須使用 application/json"
    );
  }
  const length = Number(req.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > 256 * 1024) {
    throw new DomainError(413, "REQUEST_TOO_LARGE", "請求內容超過限制");
  }
  const origin = req.get("origin");
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new DomainError(403, "ORIGIN_FORBIDDEN", "不接受跨站請求");
  }
  // Fetch Metadata is a browser-controlled header. Same-origin requests remain
  // same-origin even when a trusted Preview proxy rewrites the upstream Host.
  if (
    req.get("sec-fetch-site") === "same-origin" &&
    (parsed.protocol === "https:" || parsed.protocol === "http:")
  )
    return;
  const expectedHost = firstHeader(
    req.get("x-forwarded-host") ?? req.get("host")
  );
  const expectedProtocol =
    firstHeader(req.get("x-forwarded-proto")) || req.protocol;
  if (
    !expectedHost ||
    parsed.host !== expectedHost ||
    parsed.protocol.replace(":", "") !== expectedProtocol
  ) {
    throw new DomainError(403, "ORIGIN_FORBIDDEN", "不接受跨站請求");
  }
}

type LimitBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, LimitBucket>();

/** Ephemeral abuse protection only; it is never a source of business state. */
export function assertRateLimit(
  scope: string,
  key: string,
  max: number,
  windowMs: number
): void {
  const now = Date.now();
  const bucketKey = `${scope}:${sha256(key)}`;
  const current = rateBuckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (current.count >= max) {
    throw new DomainError(429, "RATE_LIMITED", "操作過於頻繁，請稍後再試");
  }
  current.count += 1;
}
