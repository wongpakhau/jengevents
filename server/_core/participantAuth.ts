import { createHmac, randomUUID } from "node:crypto";
import type { CookieOptions, Express, Request, Response } from "express";
import { jwtVerify, SignJWT } from "jose";
import { COOKIE_NAME } from "../../shared/const";
import {
  PARTICIPANT_COOKIE,
  PARTICIPANT_SESSION_SECONDS,
  type ParticipantStatus,
  type TemporaryParticipant,
} from "../../shared/participant";
import { DomainError } from "../eventflow/engine";
import { assertRateLimit, assertSameOriginJson } from "../eventflow/security";
import { getSessionCookieOptions } from "./cookies";
import { clearGoogleTransactionCookie } from "./googleTransactionCookie";

const ISSUER = "eventflow-participant";
const TOKEN_TYPE = "participant-session+jwt";
const KEY_DOMAIN = "eventflow-participant-session-v1";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_CLAIMS = new Set(["iss", "aud", "sub", "iat", "exp", "role"]);

// Match the Google session's cross-site cookie options without importing its DB or
// Google integration. This only clears this website's cookie, not Google login.
const GOOGLE_SESSION_COOKIE = "eventflow_google_session";
const LOCAL_SESSION_COOKIE = "eventflow_local_session";
const GOOGLE_SECURE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
};

function configuration() {
  const projectId = process.env.MANUS_PROJECT_ID?.trim();
  const secret = process.env.MANUS_JWT_SECRET;
  if (!projectId || !secret) {
    throw new DomainError(
      503,
      "PARTICIPANT_AUTH_UNAVAILABLE",
      "參與者登入暫時無法使用"
    );
  }
  return {
    projectId,
    // Bind both purpose and project to the managed secret; no raw platform key
    // or staff/Google JWT can be used as a participant credential.
    key: createHmac("sha256", secret)
      .update(JSON.stringify([KEY_DOMAIN, projectId]), "utf8")
      .digest(),
  };
}

function unauthorized(): DomainError {
  return new DomainError(
    401,
    "PARTICIPANT_UNAUTHORIZED",
    "參與者登入已失效，請重新登入"
  );
}

function cookieParts(req: Request): string[] {
  return (req.headers.cookie ?? "")
    .split(";")
    .map(part => part.trim())
    .filter(part => part.split("=", 1)[0]?.trim() === PARTICIPANT_COOKIE);
}

/** Presence is deliberately independent of validity, to prevent staff fallback. */
export function hasParticipantCookie(req: Request): boolean {
  return cookieParts(req).length !== 0;
}

function cookieValue(req: Request): string | undefined {
  const parts = cookieParts(req);
  if (parts.length === 0) return undefined;
  if (parts.length !== 1) throw unauthorized();
  const separator = parts[0]!.indexOf("=");
  if (separator < 0) throw unauthorized();
  let value: string;
  try {
    value = decodeURIComponent(parts[0]!.slice(separator + 1));
  } catch {
    throw unauthorized();
  }
  if (!value || value.length > 4096) throw unauthorized();
  return value;
}

/** Read-only verification: no DB, user creation, staff grants, or renewal. */
export async function readParticipantSession(
  req: Request
): Promise<TemporaryParticipant | null> {
  try {
    const token = cookieValue(req);
    if (token === undefined) return null;
    const config = configuration();
    const now = new Date();
    const { payload, protectedHeader } = await jwtVerify(token, config.key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: config.projectId,
      typ: TOKEN_TYPE,
      requiredClaims: ["iss", "aud", "sub", "iat", "exp", "role"],
      maxTokenAge: PARTICIPANT_SESSION_SECONDS,
      clockTolerance: 0,
      currentDate: now,
    });
    if (
      protectedHeader.typ !== TOKEN_TYPE ||
      payload.aud !== config.projectId ||
      typeof payload.sub !== "string" ||
      !UUID_V4.test(payload.sub) ||
      payload.role !== "participant" ||
      Object.keys(payload).some(claim => !SESSION_CLAIMS.has(claim)) ||
      typeof payload.iat !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      payload.iat < 0 ||
      payload.iat > Math.floor(now.getTime() / 1000) ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp !== payload.iat + PARTICIPANT_SESSION_SECONDS ||
      payload.exp * 1000 <= now.getTime()
    ) {
      throw unauthorized();
    }
    // Never copy caller-supplied JWT claims into the public identity.
    return {
      id: payload.sub,
      role: "participant",
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  } catch {
    // Present malformed/expired/unverifiable cookies always fail closed with 401.
    // Do not disclose JOSE details, configuration, cookies, or token claims.
    throw unauthorized();
  }
}

function firstHeader(value: string | undefined): string {
  return (value ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
}

function isLoopbackHost(host: string): boolean {
  return /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host);
}

function isExplicitLocalHttp(req: Request): boolean {
  const host = firstHeader(req.get("x-forwarded-host") ?? req.get("host"));
  if (!isLoopbackHost(host)) return false;
  const forwardedProtocol = firstHeader(req.get("x-forwarded-proto"));
  if (forwardedProtocol && forwardedProtocol !== "http") return false;
  const origin = req.get("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:" || !isLoopbackHost(url.host.toLowerCase())) {
        return false;
      }
    } catch {
      return false;
    }
  }
  // Public/Preview requests always default to Secure even on HTTP upstreams.
  // req.protocol is considered only after an explicit loopback host check; do
  // not infer public TLS from NODE_ENV or the proxy's internal req.secure.
  return (forwardedProtocol || req.protocol) === "http";
}

function participantCookieOptions(req: Request): CookieOptions {
  const options = getSessionCookieOptions(req);
  return isExplicitLocalHttp(req)
    ? { ...options, httpOnly: true, path: "/", sameSite: "lax", secure: false }
    : { ...options, httpOnly: true, path: "/", sameSite: "none", secure: true };
}

export function clearParticipantSession(req: Request, res: Response): void {
  res.clearCookie(PARTICIPANT_COOKIE, participantCookieOptions(req));
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
  // The shared helper permits absent Origin for CLI callers. Fetch Metadata
  // must still reject cross-site/same-site mutations even WITHOUT Origin.
  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    throw new DomainError(403, "ORIGIN_FORBIDDEN", "不接受跨站請求");
  }
  assertSameOriginJson(req);
  if (
    req.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new DomainError(
      415,
      "JSON_REQUIRED",
      "請求必須使用 application/json"
    );
  }
  const body: unknown = req.body;
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype ||
    Reflect.ownKeys(body).length !== 0
  ) {
    throw new DomainError(400, "INVALID_BODY", "請求內容只接受空白 JSON 物件");
  }
}

function rateLimit(req: Request, scope: string, max: number): void {
  assertRateLimit(
    scope,
    req.ip || req.socket?.remoteAddress || "unknown",
    max,
    60_000
  );
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof DomainError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(503).json({
    error: "參與者登入暫時無法使用",
    code: "PARTICIPANT_AUTH_UNAVAILABLE",
  });
}

function status(
  session: TemporaryParticipant | null,
  expired = false
): ParticipantStatus {
  return {
    session,
    serverNow: new Date().toISOString(),
    ...(expired ? { expired: true } : {}),
  };
}

/** Mount before the SPA catch-all; this module never mounts staff/Google routes. */
export function registerParticipantAuthRoutes(app: Express): void {
  app.post("/api/auth/participant/start", async (req, res) => {
    securityHeaders(res);
    try {
      assertMutation(req);
      rateLimit(req, "participant-start", 60);
      let session: TemporaryParticipant | null;
      try {
        session = await readParticipantSession(req);
      } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 401)
          throw error;
        clearParticipantSession(req, res);
        session = null;
      }
      if (session && Date.parse(session.expiresAt) <= Date.now())
        session = null;
      if (!session) {
        const config = configuration();
        const issuedAt = Math.floor(Date.now() / 1000);
        const expiresAt = issuedAt + PARTICIPANT_SESSION_SECONDS;
        const id = randomUUID();
        const token = await new SignJWT({ role: "participant" })
          .setProtectedHeader({ alg: "HS256", typ: TOKEN_TYPE })
          .setIssuer(ISSUER)
          .setAudience(config.projectId)
          .setSubject(id)
          .setIssuedAt(issuedAt)
          .setExpirationTime(expiresAt)
          .sign(config.key);
        session = {
          id,
          role: "participant",
          issuedAt: new Date(issuedAt * 1000).toISOString(),
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        };
        res.cookie(PARTICIPANT_COOKIE, token, {
          ...participantCookieOptions(req),
          // JWT precision is seconds; do not accidentally add signing time or
          // fractional seconds to the browser's fixed absolute deadline.
          maxAge: Math.max(0, expiresAt * 1000 - Date.now()),
        });
      }
      // Repeated start returns the same identity/deadline without reissuing JWT.
      res.clearCookie(GOOGLE_SESSION_COOKIE, GOOGLE_SECURE_OPTIONS);
      res.clearCookie(LOCAL_SESSION_COOKIE, GOOGLE_SECURE_OPTIONS);
      res.clearCookie(COOKIE_NAME, getSessionCookieOptions(req));
      clearGoogleTransactionCookie(res);
      res.json(status(session));
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/auth/participant/session", async (req, res) => {
    securityHeaders(res);
    try {
      const session = await readParticipantSession(req);
      if (session && Date.parse(session.expiresAt) <= Date.now()) {
        clearParticipantSession(req, res);
        res.json(status(null, true));
        return;
      }
      res.json(status(session));
    } catch (error) {
      if (error instanceof DomainError && error.status === 401) {
        clearParticipantSession(req, res);
        res.json(status(null, true));
        return;
      }
      handleError(res, error);
    }
  });

  app.post("/api/auth/participant/logout", (req, res) => {
    securityHeaders(res);
    try {
      assertMutation(req);
      rateLimit(req, "participant-logout", 120);
      clearParticipantSession(req, res);
      clearGoogleTransactionCookie(res);
      res.json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  });
}
