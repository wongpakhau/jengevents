import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { CookieOptions, Express, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { COOKIE_NAME } from "../../shared/const";
import { ForbiddenError } from "../../shared/_core/errors";
import * as db from "../db";
import { GOOGLE_TRUSTED_ORIGINS } from "./googleOrigins";
import { getSessionCookieOptions } from "./cookies";
import {
  GOOGLE_TRANSACTION_COOKIE as TRANSACTION_COOKIE,
  GOOGLE_TRANSACTION_COOKIE_OPTIONS as COOKIE_OPTIONS,
  clearGoogleTransactionCookie,
} from "./googleTransactionCookie";
import type { AuthenticatedUser } from "./sdk";
import {
  hasParticipantCookie,
  clearParticipantSession,
} from "./participantAuth";

export const GOOGLE_SESSION_COOKIE = "eventflow_google_session";

const CALLBACK_PATH = "/api/auth/google/callback";
const LOGIN_PATH = "/api/auth/google/start";
const SESSION_ISSUER = "eventflow-google";
const TRANSACTION_ISSUER = "eventflow-google-transaction";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const TRANSACTION_SECONDS = 10 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const RETURN_PATHS = new Set(["/", "/join", "/access"]);
const GOOGLE_SESSION_COOKIE_OPTIONS: CookieOptions = {
  ...COOKIE_OPTIONS,
  sameSite: "none",
};
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: REQUEST_TIMEOUT_MS, cooldownDuration: 30_000 }
);

type ErrorCode =
  | "configuration"
  | "google_cancelled"
  | "state_invalid"
  | "token_invalid"
  | "storage_error"
  | "top_level_required";

class GoogleFlowError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

function sessionConfiguration() {
  const projectId = process.env.MANUS_PROJECT_ID?.trim();
  const secret = process.env.MANUS_JWT_SECRET;
  // Platform keys have no promised format/length. Derive a domain-separated 32-byte
  // application key without changing or exposing the managed secret.
  if (!projectId || !secret) {
    throw new GoogleFlowError("configuration");
  }
  return {
    projectId,
    secret: createHmac("sha256", secret)
      .update("eventflow-google-session-v1")
      .digest(),
  };
}

function configuration() {
  const session = sessionConfiguration();
  // Accept the legacy mixed-case names as well as the standard uppercase names.
  const clientId = (
    process.env.GOOGLE_CLIENT_ID ?? process.env.Google_CLIENT_ID
  )?.trim();
  const clientSecret =
    process.env.GOOGLE_CLIENT_SECRET ?? process.env.Google_CLIENT_SECRET;
  if (!clientId || !clientSecret?.trim() || trustedOrigins().size === 0) {
    throw new GoogleFlowError("configuration");
  }
  return { ...session, clientId, clientSecret };
}

function securityHeaders(res: Response) {
  res.set({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
  });
}

/** Reject the entire configuration if any entry is not a canonical HTTPS origin. */
function trustedOrigins(): Map<string, string> {
  const origins = new Map<string, string>();
  for (const origin of GOOGLE_TRUSTED_ORIGINS) {
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        url.hostname.includes("*")
      )
        return new Map();
      origins.set(url.host, origin);
    } catch {
      return new Map();
    }
  }
  return origins;
}

function trustedOriginForRequest(req: Request): string | undefined {
  // Only the Host itself may select an explicitly configured origin. Forwarded
  // headers are not authenticated here and must not turn an unknown host into
  // a trusted one; the ingress must preserve the public Host.
  const value = req.headers.host;
  if (typeof value !== "string") return undefined;
  const host = value.trim().toLowerCase();
  const origins = trustedOrigins();
  const direct = origins.get(host);
  if (direct) return direct;
  if (!host.endsWith(":443")) return undefined;
  const origin = origins.get(host.slice(0, -4));
  return origin && !new URL(origin).port ? origin : undefined;
}

function assertTopLevelProductionRequest(req: Request) {
  const destination = req.headers["sec-fetch-dest"];
  const origin = trustedOriginForRequest(req);
  if (!origin || (destination !== undefined && destination !== "document")) {
    throw new GoogleFlowError("top_level_required");
  }
  return origin;
}

function safeRedirect(res: Response, code: ErrorCode) {
  // Never send a failing request to a deployment or a request-supplied host.
  res.redirect(303, `/?authError=${code}`);
}

/** An empty, malformed or duplicated Google cookie is present, not absent. */
function readCookie(req: Request, name: string): string | undefined {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map(part => part.trim())
    .filter(part => part.split("=", 1)[0]?.trim() === name);
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error("Invalid Google cookie");
  const separator = values[0]!.indexOf("=");
  if (separator < 0) throw new Error("Invalid Google cookie");
  let value: string;
  try {
    value = decodeURIComponent(values[0]!.slice(separator + 1));
  } catch {
    throw new Error("Invalid Google cookie");
  }
  if (!value || value.length > 4096) throw new Error("Invalid Google cookie");
  return value;
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function isRandomToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function equalToken(actual: unknown, expected: string) {
  return (
    isRandomToken(actual) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

function isGoogleSubject(value: unknown): value is string {
  // The existing users.openId is varchar(64); reserve seven bytes for google:.
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,57}$/.test(value);
}

async function verifiedTransaction(
  req: Request,
  config: ReturnType<typeof configuration>,
  expectedRedirectUri: string
) {
  try {
    const cookie = readCookie(req, TRANSACTION_COOKIE);
    if (!cookie) throw new Error("Missing transaction");
    const { payload, protectedHeader } = await jwtVerify(
      cookie,
      config.secret,
      {
        algorithms: ["HS256"],
        issuer: TRANSACTION_ISSUER,
        audience: config.projectId,
        requiredClaims: ["iat", "exp", "state", "nonce", "verifier"],
        maxTokenAge: TRANSACTION_SECONDS,
      }
    );
    if (
      protectedHeader.typ !== "oauth-transaction+jwt" ||
      !isRandomToken(payload.state) ||
      !isRandomToken(payload.nonce) ||
      !isRandomToken(payload.verifier) ||
      !equalToken(req.query.state, payload.state) ||
      payload.redirectUri !== expectedRedirectUri ||
      payload.clientId !== config.clientId ||
      typeof payload.returnTo !== "string" ||
      !RETURN_PATHS.has(payload.returnTo) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= payload.iat ||
      payload.exp > payload.iat + TRANSACTION_SECONDS
    ) {
      throw new Error("Invalid transaction");
    }
    return {
      nonce: payload.nonce,
      verifier: payload.verifier,
      returnTo: payload.returnTo,
      redirectUri: expectedRedirectUri,
    };
  } catch {
    throw new GoogleFlowError("state_invalid");
  }
}

async function exchangeAndVerify(
  code: string,
  transaction: Awaited<ReturnType<typeof verifiedTransaction>>,
  config: ReturnType<typeof configuration>
) {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: transaction.redirectUri,
        code_verifier: transaction.verifier,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Token exchange failed");
    const token: unknown = await response.json();
    const idToken =
      token && typeof token === "object" && "id_token" in token
        ? token.id_token
        : undefined;
    if (typeof idToken !== "string" || idToken.length > 16_384) {
      throw new Error("Missing ID token");
    }
    const { payload } = await jwtVerify(idToken, googleKeys, {
      algorithms: ["RS256"],
      issuer: ["accounts.google.com", "https://accounts.google.com"],
      audience: config.clientId,
      requiredClaims: ["sub", "exp", "iat", "nonce", "email", "email_verified"],
    });
    if (
      !equalToken(payload.nonce, transaction.nonce) ||
      !isGoogleSubject(payload.sub) ||
      payload.email_verified !== true ||
      typeof payload.email !== "string" ||
      payload.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+$/.test(payload.email) ||
      (payload.azp !== undefined && payload.azp !== config.clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== config.clientId)
    ) {
      throw new Error("Invalid Google identity");
    }
    return {
      openId: `google:${payload.sub}`,
      email: payload.email,
      name:
        typeof payload.name === "string" ? payload.name.slice(0, 256) : null,
    };
  } catch {
    // Never disclose Google error bodies, authorization codes or token claims.
    throw new GoogleFlowError("token_invalid");
  }
}

/** Mount before the SPA catch-all. Login must open the production site in a tab. */
export function registerGoogleAuthRoutes(app: Express): void {
  app.get("/api/auth/google/status", (req, res) => {
    securityHeaders(res);
    let configured = false;
    try {
      configuration();
      configured = trustedOriginForRequest(req) !== undefined;
    } catch {
      // A boolean is the only public configuration information.
    }
    res.json({ configured, loginPath: LOGIN_PATH });
  });

  app.get(LOGIN_PATH, async (req, res) => {
    securityHeaders(res);
    try {
      const config = configuration();
      const origin = assertTopLevelProductionRequest(req);
      const redirectUri = `${origin}${CALLBACK_PATH}`;
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken();
      const returnTo =
        typeof req.query.returnTo === "string" &&
        RETURN_PATHS.has(req.query.returnTo)
          ? req.query.returnTo
          : "/";
      const transaction = await new SignJWT({
        state,
        nonce,
        verifier,
        redirectUri,
        clientId: config.clientId,
        returnTo,
      })
        .setProtectedHeader({ alg: "HS256", typ: "oauth-transaction+jwt" })
        .setIssuer(TRANSACTION_ISSUER)
        .setAudience(config.projectId)
        .setIssuedAt()
        .setExpirationTime(`${TRANSACTION_SECONDS}s`)
        .sign(config.secret);
      if (hasParticipantCookie(req)) clearParticipantSession(req, res);
      res.cookie(TRANSACTION_COOKIE, transaction, {
        ...COOKIE_OPTIONS,
        maxAge: TRANSACTION_SECONDS * 1000,
      });
      const authorization = new URL(
        "https://accounts.google.com/o/oauth2/v2/auth"
      );
      authorization.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        prompt: "select_account",
        state,
        nonce,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      res.redirect(302, authorization.toString());
    } catch (error) {
      safeRedirect(
        res,
        error instanceof GoogleFlowError ? error.code : "configuration"
      );
    }
  });

  app.get("/api/auth/google/callback", async (req, res) => {
    securityHeaders(res);
    // Consume the browser transaction even on a rejected/cancelled callback.
    // Google authorization codes are also one-use; no tokens are stored here.
    clearGoogleTransactionCookie(res);
    try {
      const config = configuration();
      const origin = assertTopLevelProductionRequest(req);
      // Always check browser binding BEFORE handling errors or exchanging code.
      const transaction = await verifiedTransaction(
        req,
        config,
        `${origin}${CALLBACK_PATH}`
      );
      if (req.query.error !== undefined) {
        throw new GoogleFlowError(
          req.query.error === "access_denied"
            ? "google_cancelled"
            : "token_invalid"
        );
      }
      const code = req.query.code;
      if (typeof code !== "string" || !code || code.length > 4096) {
        throw new GoogleFlowError("token_invalid");
      }
      const identity = await exchangeAndVerify(code, transaction, config);
      try {
        await db.upsertUser({
          ...identity,
          loginMethod: "google_direct",
          role: "user", // Explicit: bypass db.ts's ownerOpenId auto-promotion.
          lastSignedIn: new Date(),
        });
        const user = await db.getUserByOpenId(identity.openId);
        if (
          !user ||
          user.openId !== identity.openId ||
          user.loginMethod !== "google_direct"
        ) {
          throw new Error("Google user was not persisted");
        }
      } catch {
        throw new GoogleFlowError("storage_error");
      }
      const session = await new SignJWT({
        authProvider: "google",
        emailVerified: true,
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(SESSION_ISSUER)
        .setAudience(config.projectId)
        .setSubject(identity.openId)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_SECONDS}s`)
        .sign(config.secret);
      res.cookie(GOOGLE_SESSION_COOKIE, session, {
        ...GOOGLE_SESSION_COOKIE_OPTIONS,
        maxAge: SESSION_SECONDS * 1000,
      });
      res.redirect(303, `${origin}${transaction.returnTo}`);
    } catch (error) {
      safeRedirect(
        res,
        error instanceof GoogleFlowError ? error.code : "token_invalid"
      );
    }
  });

  app.post("/api/auth/google/logout", (req, res) => {
    securityHeaders(res);
    const origin = trustedOriginForRequest(req);
    // An explicit Origin and JSON content type reject cross-site/simple forms.
    if (
      !origin ||
      req.headers.origin !== origin ||
      req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json" ||
      (req.headers["sec-fetch-site"] !== undefined &&
        req.headers["sec-fetch-site"] !== "same-origin")
    ) {
      res.status(403).json({ ok: false });
      return;
    }
    res.clearCookie(GOOGLE_SESSION_COOKIE, GOOGLE_SESSION_COOKIE_OPTIONS);
    res.clearCookie(COOKIE_NAME, getSessionCookieOptions(req));
    clearGoogleTransactionCookie(res);
    res.json({ ok: true });
  });
}

/**
 * Only the direct Google cookie is considered. Null means absent; ANY present
 * invalid cookie throws, so the caller must not catch and fall back to Manus.
 * Authentication is read-only: never sync users or update roles from a JWT.
 */
export async function authenticateGoogleRequest(
  req: Request
): Promise<AuthenticatedUser | null> {
  try {
    const session = readCookie(req, GOOGLE_SESSION_COOKIE);
    if (session === undefined) return null;
    if (!trustedOriginForRequest(req)) throw new Error("Untrusted host");
    const config = sessionConfiguration();
    const { payload, protectedHeader } = await jwtVerify(
      session,
      config.secret,
      {
        algorithms: ["HS256"],
        issuer: SESSION_ISSUER,
        audience: config.projectId,
        requiredClaims: ["sub", "iat", "exp", "authProvider", "emailVerified"],
        maxTokenAge: SESSION_SECONDS,
      }
    );
    if (
      protectedHeader.typ !== "JWT" ||
      typeof payload.sub !== "string" ||
      !payload.sub.startsWith("google:") ||
      !isGoogleSubject(payload.sub.slice(7)) ||
      payload.authProvider !== "google" ||
      payload.emailVerified !== true ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= payload.iat ||
      payload.exp > payload.iat + SESSION_SECONDS
    ) {
      throw new Error("Invalid Google session");
    }
    const user = await db.getUserByOpenId(payload.sub);
    if (
      !user ||
      user.openId !== payload.sub ||
      user.loginMethod !== "google_direct"
    ) {
      throw new Error("Invalid Google user");
    }
    const authenticatedUser = {
      ...user,
      authProvider: "google" as const,
      emailVerified: true as const,
    };
    return authenticatedUser;
  } catch {
    throw ForbiddenError("Invalid Google session");
  }
}
