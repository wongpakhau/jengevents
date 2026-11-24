import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { CookieOptions, Express, Request, Response } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { jwtVerify, SignJWT } from "jose";
import { COOKIE_NAME } from "../../shared/const";
import {
  LOCAL_LOGIN_PATH,
  LOCAL_LOGOUT_PATH,
  LOCAL_SESSION_COOKIE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
  normalizeUsername,
  type LocalLoginResult,
} from "../../shared/local-login";
import { PARTICIPANT_COOKIE } from "../../shared/participant";
import { ForbiddenError } from "../../shared/_core/errors";
import * as db from "../db";
import { getPool, readRows, withTransaction } from "../eventflow/database";
import { DomainError } from "../eventflow/engine";
import {
  assertRateLimit,
  assertSameOriginJson,
  newCapabilityToken,
  sha256,
} from "../eventflow/security";
import { getSessionCookieOptions } from "./cookies";
import { clearGoogleTransactionCookie } from "./googleTransactionCookie";
import type { AuthenticatedUser } from "./sdk";

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  cost: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keylen,
      { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived))
    );
  });
}
const ISSUER = "eventflow-local";
const TOKEN_TYPE = "local-session+jwt";
const KEY_DOMAIN = "eventflow-local-session-v1";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
/** A member login mints a guest invitation that lasts this long. */
const MEMBER_INVITE_DAYS = 30;
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Same cross-site options as the Google session so Preview and the standalone
// tab behave identically; this only clears this website's cookies.
const GOOGLE_SESSION_COOKIE = "eventflow_google_session";
const SECURE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
};

export type LocalAccountRow = RowDataPacket & {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  kind: "staff" | "member";
  user_id: number | null;
  event_id: string | null;
  guest_id: string | null;
  active: number;
  created_by: number;
  created_at: Date | string;
  updated_at: Date | string;
  last_login_at: Date | string | null;
};

/** users.openId for a staff account; the column is varchar(64). */
export function localOpenId(accountId: string): string {
  return `local:${accountId}`;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_COST);
  return `scrypt$${SCRYPT_COST}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [scheme, cost, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !cost || !salt || !hash) return false;
  const n = Number(cost);
  if (!Number.isSafeInteger(n) || n < 1024 || n > 1_048_576) return false;
  const expected = Buffer.from(hash, "base64url");
  let derived: Buffer;
  try {
    derived = await scrypt(
      password,
      Buffer.from(salt, "base64url"),
      expected.length,
      n
    );
  } catch {
    return false;
  }
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}

export function validatePassword(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH ||
    value.trim() !== value
  )
    throw new DomainError(
      400,
      "INVALID_PASSWORD",
      `密碼須為 ${PASSWORD_MIN_LENGTH} 至 ${PASSWORD_MAX_LENGTH} 個字元，前後不可有空格`
    );
  return value;
}

export function validateUsername(value: unknown): string {
  if (typeof value !== "string")
    throw new DomainError(400, "INVALID_USERNAME", "請輸入帳號");
  const username = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(username))
    throw new DomainError(
      400,
      "INVALID_USERNAME",
      "帳號只可用小寫英文、數字、點、底線或減號，3 至 32 個字元"
    );
  return username;
}

function configuration() {
  const projectId = process.env.MANUS_PROJECT_ID?.trim();
  const secret = process.env.MANUS_JWT_SECRET;
  if (!projectId || !secret)
    throw new DomainError(
      503,
      "LOCAL_AUTH_UNAVAILABLE",
      "帳號登入暫時無法使用"
    );
  return {
    projectId,
    key: createHmac("sha256", secret)
      .update(JSON.stringify([KEY_DOMAIN, projectId]), "utf8")
      .digest(),
  };
}

function cookieParts(req: Request): string[] {
  return (req.headers.cookie ?? "")
    .split(";")
    .map(part => part.trim())
    .filter(part => part.split("=", 1)[0]?.trim() === LOCAL_SESSION_COOKIE);
}

export function hasLocalCookie(req: Request): boolean {
  return cookieParts(req).length !== 0;
}

function cookieValue(req: Request): string | undefined {
  const parts = cookieParts(req);
  if (parts.length === 0) return undefined;
  if (parts.length !== 1) throw new Error("Invalid local cookie");
  const separator = parts[0]!.indexOf("=");
  if (separator < 0) throw new Error("Invalid local cookie");
  const value = decodeURIComponent(parts[0]!.slice(separator + 1));
  if (!value || value.length > 4096) throw new Error("Invalid local cookie");
  return value;
}

function firstHeader(value: string | undefined): string {
  return (value ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
}

function isLoopbackHost(host: string): boolean {
  return /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host);
}

/** Only an explicit loopback HTTP request gets a non-Secure cookie. */
function isExplicitLocalHttp(req: Request): boolean {
  const host = firstHeader(req.get("x-forwarded-host") ?? req.get("host"));
  if (!isLoopbackHost(host)) return false;
  const forwardedProtocol = firstHeader(req.get("x-forwarded-proto"));
  if (forwardedProtocol && forwardedProtocol !== "http") return false;
  return (forwardedProtocol || req.protocol) === "http";
}

function localCookieOptions(req: Request): CookieOptions {
  const options = getSessionCookieOptions(req);
  return isExplicitLocalHttp(req)
    ? { ...options, httpOnly: true, path: "/", sameSite: "lax", secure: false }
    : { ...options, httpOnly: true, path: "/", sameSite: "none", secure: true };
}

export function clearLocalSession(req: Request, res: Response): void {
  res.clearCookie(LOCAL_SESSION_COOKIE, localCookieOptions(req));
}

function securityHeaders(res: Response): void {
  res.set({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
  });
}

function assertMutation(req: Request): void {
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin")
    throw new DomainError(403, "ORIGIN_FORBIDDEN", "不接受跨站請求");
  assertSameOriginJson(req);
  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new DomainError(400, "INVALID_BODY", "請求內容不正確");
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof DomainError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res
    .status(503)
    .json({ error: "帳號登入暫時無法使用", code: "LOCAL_AUTH_UNAVAILABLE" });
}

function sqlDate(value: Date): string {
  return value.toISOString().slice(0, 23).replace("T", " ");
}

function invalidCredentials(): DomainError {
  return new DomainError(401, "INVALID_CREDENTIALS", "帳號或密碼不正確");
}

/** Role-specific first screen for a staff account, mirroring the client role homes. */
function staffReturnPath(roles: readonly string[]): string {
  if (roles.includes("merchant") && roles.length === 1) return "/merchant";
  if (roles.includes("checkin") && roles.length === 1) return "/checkin";
  if (roles.includes("draw") && roles.length === 1) return "/draw";
  if (roles.includes("guest_manager") && roles.length === 1) return "/guests";
  return "/";
}

/** Mount before the SPA catch-all. Never mounts Google or participant routes. */
export function registerLocalAuthRoutes(app: Express): void {
  app.post(LOCAL_LOGIN_PATH, async (req, res) => {
    securityHeaders(res);
    try {
      assertMutation(req);
      const body = req.body as Record<string, unknown>;
      const address = req.ip || req.socket?.remoteAddress || "unknown";
      assertRateLimit("local-login-ip", address, 30, 60_000);
      let username: string;
      try {
        username = validateUsername(body.username);
        validatePassword(body.password);
      } catch {
        throw invalidCredentials();
      }
      assertRateLimit("local-login-user", username, 10, 60_000);
      const rows = await readRows<LocalAccountRow>(
        "SELECT * FROM ef_local_accounts WHERE username = ? LIMIT 1",
        [username]
      );
      const account = rows[0];
      // Always run one hash verification so timing does not reveal usernames.
      const ok = await verifyPassword(
        body.password as string,
        account?.password_hash ??
          "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      );
      if (!account || !ok || !account.active) throw invalidCredentials();
      const now = new Date();
      let result: LocalLoginResult;
      if (account.kind === "staff") {
        const openId = localOpenId(account.id);
        await db.upsertUser({
          openId,
          name: account.display_name,
          loginMethod: "local_password",
          role: "user",
          lastSignedIn: now,
        });
        const user = await db.getUserByOpenId(openId);
        if (!user || user.loginMethod !== "local_password")
          throw new DomainError(
            503,
            "LOCAL_AUTH_UNAVAILABLE",
            "帳號登入暫時無法使用"
          );
        if (account.user_id !== user.id)
          await getPool().execute(
            "UPDATE ef_local_accounts SET user_id = ?, updated_at = ? WHERE id = ?",
            [user.id, sqlDate(now), account.id]
          );
        const config = configuration();
        const issuedAt = Math.floor(now.getTime() / 1000);
        const token = await new SignJWT({ kind: "staff" })
          .setProtectedHeader({ alg: "HS256", typ: TOKEN_TYPE })
          .setIssuer(ISSUER)
          .setAudience(config.projectId)
          .setSubject(account.id)
          .setIssuedAt(issuedAt)
          .setExpirationTime(issuedAt + SESSION_SECONDS)
          .sign(config.key);
        const members = await readRows<RowDataPacket>(
          "SELECT role FROM ef_members WHERE user_id = ? AND active = 1",
          [user.id]
        );
        res.cookie(LOCAL_SESSION_COOKIE, token, {
          ...localCookieOptions(req),
          maxAge: SESSION_SECONDS * 1000,
        });
        // A staff session replaces any participant, Google or Manus session.
        res.clearCookie(PARTICIPANT_COOKIE, SECURE_OPTIONS);
        res.clearCookie(GOOGLE_SESSION_COOKIE, SECURE_OPTIONS);
        res.clearCookie(COOKIE_NAME, getSessionCookieOptions(req));
        clearGoogleTransactionCookie(res);
        result = {
          kind: "staff",
          returnTo: staffReturnPath(members.map(row => String(row.role))),
          displayName: account.display_name,
        };
      } else {
        if (!account.event_id || !account.guest_id) throw invalidCredentials();
        // A member login mints a fresh invitation; the guest page keeps using
        // the existing X-Guest-Token flow, so nothing else changes for guests.
        const token = newCapabilityToken();
        const expires = new Date(
          now.getTime() + MEMBER_INVITE_DAYS * 24 * 60 * 60 * 1000
        );
        await withTransaction(async connection => {
          const [events] = await connection.query<RowDataPacket[]>(
            "SELECT id,event_state FROM ef_events WHERE id = ? AND owner_user_id IS NOT NULL LIMIT 1 FOR UPDATE",
            [account.event_id]
          );
          const row = events[0];
          let found = false;
          try {
            const state = JSON.parse(String(row?.event_state ?? "null")) as {
              guests?: { id: string; excludedFromEvent?: boolean }[];
              event?: { mode?: string };
            } | null;
            found = Boolean(
              state?.guests?.some(
                guest =>
                  guest.id === account.guest_id &&
                  !(
                    state.event?.mode === "attendance" &&
                    guest.excludedFromEvent === true
                  )
              )
            );
          } catch {
            found = false;
          }
          if (!row || !found) throw invalidCredentials();
          await connection.execute(
            "INSERT INTO ef_invites (id,event_id,kind,token_hash,guest_id,role,merchant_id,name,version,expires_at,created_at) VALUES (?,?,?,?,?,NULL,NULL,?,?,?,?)",
            [
              randomUUID(),
              account.event_id,
              "guest",
              sha256(token),
              account.guest_id,
              `local-login:${account.username}`.slice(0, 200),
              1,
              sqlDate(expires),
              sqlDate(now),
            ]
          );
        });
        result = {
          kind: "member",
          path: `/guest#invite=${token}`,
          displayName: account.display_name,
        };
      }
      await getPool().execute(
        "UPDATE ef_local_accounts SET last_login_at = ? WHERE id = ?",
        [sqlDate(now), account.id]
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post(LOCAL_LOGOUT_PATH, (req, res) => {
    securityHeaders(res);
    try {
      assertMutation(req);
      clearLocalSession(req, res);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });
}

/**
 * Only the local cookie is considered. Null means absent; ANY present invalid
 * cookie throws, so the caller must not fall back to another identity.
 */
export async function authenticateLocalRequest(
  req: Request
): Promise<AuthenticatedUser | null> {
  let token: string | undefined;
  try {
    token = cookieValue(req);
  } catch {
    throw ForbiddenError("Invalid local session");
  }
  if (token === undefined) return null;
  try {
    const config = configuration();
    const { payload, protectedHeader } = await jwtVerify(token, config.key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: config.projectId,
      typ: TOKEN_TYPE,
      requiredClaims: ["sub", "iat", "exp", "kind"],
      maxTokenAge: SESSION_SECONDS,
    });
    if (
      protectedHeader.typ !== TOKEN_TYPE ||
      typeof payload.sub !== "string" ||
      !UUID_V4.test(payload.sub) ||
      payload.kind !== "staff"
    )
      throw new Error("Invalid local session");
    const rows = await readRows<LocalAccountRow>(
      "SELECT * FROM ef_local_accounts WHERE id = ? LIMIT 1",
      [payload.sub]
    );
    const account = rows[0];
    if (!account || !account.active || account.kind !== "staff")
      throw new Error("Local account unavailable");
    const user = await db.getUserByOpenId(localOpenId(account.id));
    if (
      !user ||
      user.loginMethod !== "local_password" ||
      user.id !== account.user_id
    )
      throw new Error("Local user unavailable");
    return { ...user, authProvider: "local", emailVerified: false };
  } catch {
    throw ForbiddenError("Invalid local session");
  }
}
