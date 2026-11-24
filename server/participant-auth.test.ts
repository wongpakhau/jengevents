import { createHmac } from "node:crypto";
import type { CookieOptions, Express, Request, Response } from "express";
import { decodeJwt, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../shared/const";
import {
  PARTICIPANT_COOKIE,
  PARTICIPANT_SESSION_SECONDS,
  type ParticipantStatus,
} from "../shared/participant";

// Fail immediately if this isolated authentication flow ever starts loading DB,
// users/staff access, platform SDK, or the Google integration. JOSE is NOT mocked.
const forbidden = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./db", () => {
  forbidden.load("db");
  throw new Error("Participant authentication must not load users or DB");
});
vi.mock("./eventflow/database", () => {
  forbidden.load("eventflow/database");
  throw new Error("Participant authentication must not load event data");
});
vi.mock("./_core/googleAuth", () => {
  forbidden.load("googleAuth");
  throw new Error("Participant authentication must not load Google");
});
vi.mock("./_core/sdk", () => {
  forbidden.load("sdk");
  throw new Error("Participant authentication must not load staff SDK");
});

import * as participantAuth from "./_core/participantAuth";
import { DomainError } from "./eventflow/engine";

const {
  clearParticipantSession,
  hasParticipantCookie,
  readParticipantSession,
  registerParticipantAuthRoutes,
} = participantAuth;
const ORIGIN = "https://eventflow.example.invalid";
const HOST = "eventflow.example.invalid";
const PROJECT_ID = "participant-test-project";
const SECRET = "participant-test-only-secret-not-a-production-credential";
const ISSUER = "eventflow-participant";
const TYPE = "participant-session+jwt";
const UUID = "cb91449c-644c-44e2-92a1-5f35f7bc41fa";
const NOW = new Date("2030-01-02T03:04:05.000Z");
const START = "/api/auth/participant/start";
const SESSION = "/api/auth/participant/session";
const LOGOUT = "/api/auth/participant/logout";
const PUBLIC_FLAGS = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
};
const LOCAL_FLAGS = { ...PUBLIC_FLAGS, secure: false, sameSite: "lax" };
const GOOGLE_FLAGS = { ...PUBLIC_FLAGS };
const GOOGLE_TRANSACTION = "__Host-eventflow_google_transaction";
const TRANSACTION_FLAGS = { ...PUBLIC_FLAGS };

function derivedKey(projectId = PROJECT_ID, secret = SECRET) {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify(["eventflow-participant-session-v1", projectId]),
      "utf8"
    )
    .digest();
}
const KEY = derivedKey();

type Handler = (req: Request, res: Response) => unknown;
function app() {
  const handlers = new Map<string, Handler>();
  const instance = {
    get: (path: string, handler: Handler) =>
      handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: Handler) =>
      handlers.set(`POST ${path}`, handler),
  } as unknown as Express;
  registerParticipantAuthRoutes(instance);
  return handlers;
}
const handlers = app();
let requestSequence = 0;
type RequestOverrides = {
  headers?: Record<string, string | undefined>;
  body?: unknown;
  protocol?: string;
  secure?: boolean;
  ip?: string;
};
function request(overrides: RequestOverrides = {}): Request {
  const headers = {
    host: HOST,
    origin: ORIGIN,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    "x-forwarded-proto": "https",
    ...overrides.headers,
  };
  return {
    body: {},
    protocol: "http", // Public TLS terminates at a proxy, not Express.
    secure: false,
    ip: `participant-test-client-${++requestSequence}`,
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
    headers,
    get: (name: string) => headers[name.toLowerCase() as keyof typeof headers],
  } as unknown as Request;
}
function cookieRequest(token: string, overrides: RequestOverrides = {}) {
  return request({
    ...overrides,
    headers: {
      cookie: `${PARTICIPANT_COOKIE}=${token}`,
      ...overrides.headers,
    },
  });
}
function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    cookies: [] as { name: string; value: string; options: CookieOptions }[],
    cleared: [] as { name: string; options: CookieOptions }[],
    cookie(name: string, value: string, options: CookieOptions) {
      this.cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name: string, options: CookieOptions) {
      this.cleared.push({ name, options });
      return this;
    },
    set(headers: Record<string, string>) {
      Object.assign(this.headers, headers);
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}
async function invoke(method: string, path: string, req = request()) {
  const res = response();
  const handler = handlers.get(`${method} ${path}`);
  if (!handler) throw new Error("Unknown participant test route");
  await handler(req, res as unknown as Response);
  expect(res.headers).toMatchObject({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
  });
  return res;
}
function state(res: ReturnType<typeof response>): ParticipantStatus {
  return res.body as ParticipantStatus;
}
function participantCookie(res: ReturnType<typeof response>) {
  const cookie = res.cookies.find(item => item.name === PARTICIPANT_COOKIE);
  expect(cookie).toBeDefined();
  return cookie!;
}
async function token(
  overrides: Record<string, unknown> = {},
  key = KEY,
  header: { alg: string; typ?: string } = { alg: "HS256", typ: TYPE }
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER,
    aud: PROJECT_ID,
    sub: UUID,
    iat: now,
    exp: now + PARTICIPANT_SESSION_SECONDS,
    role: "participant",
    ...overrides,
  })
    .setProtectedHeader(header)
    .sign(key);
}
async function expectUnauthorized(req: Request) {
  expect(hasParticipantCookie(req)).toBe(true);
  const error = await readParticipantSession(req).catch(error => error);
  expect(error).toBeInstanceOf(DomainError);
  expect(error).toMatchObject({
    status: 401,
    code: "PARTICIPANT_UNAUTHORIZED",
  });
  expect(error.message).not.toContain(SECRET);
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("MANUS_PROJECT_ID", PROJECT_ID);
  vi.stubEnv("MANUS_JWT_SECRET", SECRET);
  vi.stubEnv("OWNER_OPEN_ID", UUID);
  vi.stubEnv("DATABASE_URL", "");
  forbidden.load.mockClear();
  fetchMock = vi
    .fn()
    .mockRejectedValue(new Error("Network forbidden in participant tests"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(forbidden.load).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("participant contract and isolated routes", () => {
  it("exports exactly the four requested helpers and mounts no staff/Google routes", () => {
    expect(Object.keys(participantAuth).sort()).toEqual([
      "clearParticipantSession",
      "hasParticipantCookie",
      "readParticipantSession",
      "registerParticipantAuthRoutes",
    ]);
    expect([...handlers.keys()]).toEqual([
      `POST ${START}`,
      `GET ${SESSION}`,
      `POST ${LOGOUT}`,
    ]);
    expect(PARTICIPANT_SESSION_SECONDS).toBe(72000);
    expect(PARTICIPANT_COOKIE).toBe("eventflow_participant_session");
  });

  it("treats no participant cookie as absent, even without configured keys", async () => {
    vi.stubEnv("MANUS_JWT_SECRET", "");
    const req = request({
      headers: { cookie: `${COOKIE_NAME}=staff; unrelated=value` },
    });
    expect(hasParticipantCookie(req)).toBe(false);
    expect(await readParticipantSession(req)).toBeNull();
    const res = await invoke("GET", SESSION, req);
    expect(res.body).toEqual({ session: null, serverNow: NOW.toISOString() });
    expect(res.cookies).toEqual([]);
    expect(res.cleared).toEqual([]);
  });

  it("creates only a UUID participant, with a real 20-hour signed token and no staff grants", async () => {
    const res = await invoke("POST", START);
    expect(res.statusCode).toBe(200);
    const cookie = participantCookie(res);
    const { payload, protectedHeader } = await jwtVerify(cookie.value, KEY, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: PROJECT_ID,
      typ: TYPE,
      currentDate: NOW,
    });
    expect(protectedHeader).toEqual({ alg: "HS256", typ: TYPE });
    expect(Object.keys(payload).sort()).toEqual([
      "aud",
      "exp",
      "iat",
      "iss",
      "role",
      "sub",
    ]);
    expect(payload.role).toBe("participant");
    expect(payload.sub).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(payload.sub).not.toBe(UUID); // OWNER_OPEN_ID cannot promote or select identity.
    expect(payload.exp! - payload.iat!).toBe(72000);
    expect(state(res)).toEqual({
      session: {
        id: payload.sub,
        role: "participant",
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 72000 * 1000).toISOString(),
      },
      serverNow: NOW.toISOString(),
    });
    expect(cookie.options).toEqual({ ...PUBLIC_FLAGS, maxAge: 72000 * 1000 });
    expect(cookie.options.domain).toBeUndefined();
    expect(res.cookies).toHaveLength(1);
    expect(await readParticipantSession(cookieRequest(cookie.value))).toEqual(
      state(res).session
    );
    const another = await invoke("POST", START);
    expect(state(another).session!.id).not.toBe(state(res).session!.id);
  });

  it("is independent of token tables, user records, memory grants, and registration lifetime", async () => {
    const signed = await token();
    const first = await readParticipantSession(cookieRequest(signed));
    const independentHandlers = app();
    const res = response();
    await independentHandlers.get(`GET ${SESSION}`)!(
      cookieRequest(signed),
      res as unknown as Response
    );
    expect(state(res).session).toEqual(first);
    expect(state(res).session!.role).toBe("participant");
    expect(res.cookies).toEqual([]);
    expect(forbidden.load).not.toHaveBeenCalled();
  });

  it.each(["MANUS_PROJECT_ID", "MANUS_JWT_SECRET"])(
    "fails safely when %s is missing",
    async name => {
      const signed = await token();
      vi.stubEnv(name, "");
      const res = await invoke("POST", START);
      expect(res.statusCode).toBe(503);
      expect(res.cookies).toEqual([]);
      expect(res.cleared).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      await expectUnauthorized(cookieRequest(signed));
    }
  );

  it("derives a 32-byte project/purpose key even from a short managed secret", async () => {
    vi.stubEnv("MANUS_JWT_SECRET", "short-test-secret");
    const cookie = participantCookie(await invoke("POST", START));
    const { payload } = await jwtVerify(
      cookie.value,
      derivedKey(PROJECT_ID, "short-test-secret"),
      {
        issuer: ISSUER,
        audience: PROJECT_ID,
        currentDate: NOW,
      }
    );
    expect(payload.role).toBe("participant");
    expect(
      await readParticipantSession(cookieRequest(cookie.value))
    ).not.toBeNull();
  });

  it("does not log cookies, tokens, secrets, or JOSE errors", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map(method =>
      vi.spyOn(console, method as "log").mockImplementation(() => {})
    );
    await invoke("POST", START);
    await invoke("GET", SESSION, cookieRequest("not-a-jwt"));
    await invoke("POST", LOGOUT, cookieRequest("not-a-jwt"));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("participant fixed lifetime and no renewal", () => {
  it("is valid immediately before 20 hours, invalid at the boundary, and invalid after", async () => {
    const signed = await token();
    vi.setSystemTime(new Date(NOW.getTime() + 72000 * 1000 - 1));
    expect(await readParticipantSession(cookieRequest(signed))).toMatchObject({
      id: UUID,
      role: "participant",
    });
    vi.setSystemTime(new Date(NOW.getTime() + 72000 * 1000));
    await expectUnauthorized(cookieRequest(signed));
    vi.setSystemTime(new Date(NOW.getTime() + 72000 * 1000 + 1));
    await expectUnauthorized(cookieRequest(signed));
  });

  it("repeated start and session reads keep exactly the same id and absolute expiry", async () => {
    const started = await invoke("POST", START);
    const signed = participantCookie(started).value;
    const original = state(started).session;
    for (const elapsed of [1, 3600, 71999]) {
      vi.setSystemTime(new Date(NOW.getTime() + elapsed * 1000));
      const restarted = await invoke("POST", START, cookieRequest(signed));
      const read = await invoke("GET", SESSION, cookieRequest(signed));
      expect(state(restarted).session).toEqual(original);
      expect(state(read).session).toEqual(original);
      expect(state(read).serverNow).toBe(new Date().toISOString());
      expect(restarted.cookies).toEqual([]);
      expect(read.cookies).toEqual([]);
      expect(read.cleared).toEqual([]);
    }
  });

  it("sets maxAge to the exact remaining deadline, not 20 hours plus fractional seconds", async () => {
    vi.setSystemTime(new Date(NOW.getTime() + 789));
    const started = await invoke("POST", START);
    const cookie = participantCookie(started);
    expect(cookie.options.maxAge).toBe(72000 * 1000 - 789);
    expect(cookie.options.maxAge).toBe(
      Date.parse(state(started).session!.expiresAt) - Date.now()
    );
  });

  it("expiry status clears the cookie, reports server time, and never mints a replacement", async () => {
    const signed = await token();
    vi.setSystemTime(new Date(NOW.getTime() + 72000 * 1000));
    const res = await invoke("GET", SESSION, cookieRequest(signed));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      session: null,
      serverNow: new Date().toISOString(),
      expired: true,
    });
    expect(res.cookies).toEqual([]);
    expect(res.cleared).toEqual([
      { name: PARTICIPANT_COOKIE, options: PUBLIC_FLAGS },
    ]);
  });

  it("start can replace an expired token with a new UUID and a new fixed lifetime", async () => {
    const signed = await token();
    vi.setSystemTime(new Date(NOW.getTime() + 72000 * 1000));
    const res = await invoke("POST", START, cookieRequest(signed));
    expect(res.statusCode).toBe(200);
    expect(state(res).session!.id).not.toBe(UUID);
    expect(state(res).session!.issuedAt).toBe(new Date().toISOString());
    const payload = decodeJwt(participantCookie(res).value);
    expect(payload.exp! - payload.iat!).toBe(72000);
    expect(res.cleared).toContainEqual({
      name: PARTICIPANT_COOKIE,
      options: PUBLIC_FLAGS,
    });
  });
});

describe("participant JWT verification rejects forged authority and confusion", () => {
  it("rejects an unsigned edit of role even when all other claims look correct", async () => {
    const signed = await token();
    const [header, , signature] = signed.split(".");
    const changed = Buffer.from(
      JSON.stringify({ ...decodeJwt(signed), role: "owner" })
    ).toString("base64url");
    await expectUnauthorized(
      cookieRequest(`${header}.${changed}.${signature}`)
    );
  });

  it.each([
    "admin",
    "owner",
    "staff",
    "merchant",
    "user",
    null,
    ["participant"],
  ])("rejects a correctly signed non-participant role %j", async role =>
    expectUnauthorized(cookieRequest(await token({ role })))
  );

  it.each([
    { roles: ["admin"] },
    { staffGrants: ["*"] },
    { permissions: ["manage"] },
    { id: "caller-selected" },
    { authProvider: "google" },
  ])(
    "rejects extra authority/identity claims %j rather than copying them",
    async claims => {
      await expectUnauthorized(cookieRequest(await token(claims)));
    }
  );

  it.each([
    { iss: "eventflow-google" },
    { iss: "eventflow-platform" },
    { aud: "another-project" },
    { aud: [PROJECT_ID, "another-project"] },
    { sub: "google:someone" },
    { sub: "not-a-uuid" },
    { sub: "00000000-0000-0000-0000-000000000000" },
  ])("rejects incorrect issuer, audience, or subject %j", async claims => {
    await expectUnauthorized(cookieRequest(await token(claims)));
  });

  it.each(["iss", "aud", "sub", "iat", "exp", "role"])(
    "requires the %s claim",
    async claim => {
      await expectUnauthorized(
        cookieRequest(await token({ [claim]: undefined }))
      );
    }
  );

  it.each([
    { alg: "HS384", typ: TYPE },
    { alg: "HS512", typ: TYPE },
    { alg: "HS256", typ: "JWT" },
    { alg: "HS256", typ: "oauth-transaction+jwt" },
    { alg: "HS256", typ: TYPE.toUpperCase() },
    { alg: "HS256" },
  ])("requires HS256 and the exact participant token type %j", async header => {
    await expectUnauthorized(cookieRequest(await token({}, KEY, header)));
  });

  it("rejects alg:none and an empty signature", async () => {
    const payload = Buffer.from(
      JSON.stringify(decodeJwt(await token()))
    ).toString("base64url");
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: TYPE })
    ).toString("base64url");
    await expectUnauthorized(cookieRequest(`${header}.${payload}.`));
  });

  it("rejects raw platform, Google-purpose, and different-project signing keys", async () => {
    const keys = [
      Buffer.from(SECRET),
      createHmac("sha256", SECRET)
        .update("eventflow-google-session-v1")
        .digest(),
      derivedKey("another-project"),
      derivedKey(PROJECT_ID, "another-test-secret"),
    ];
    for (const key of keys)
      await expectUnauthorized(cookieRequest(await token({}, key)));
    const signed = await token();
    vi.stubEnv("MANUS_PROJECT_ID", "another-project");
    await expectUnauthorized(cookieRequest(signed));
  });

  it("rejects malformed time claims, future iat, and any TTL other than exactly 72000 seconds", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      { iat: String(now) },
      { exp: String(now + 72000) },
      { iat: now + 0.5 },
      { exp: now + 72000.5 },
      { iat: now + 1, exp: now + 72001 },
      { iat: -1, exp: 71999 },
      { exp: now + 72001 },
      { exp: now + 71999 },
      { exp: now },
      { iat: null },
      { exp: null },
    ];
    for (const claims of cases)
      await expectUnauthorized(cookieRequest(await token(claims)));
  });
});

describe("participant cookie presence, malformed values and duplicates", () => {
  it.each(["", "%", "%GG", "not-a-jwt", '"quoted"', "x".repeat(4097)])(
    "fails closed for malformed cookie case %# and GET clears it",
    async value => {
      const req = cookieRequest(value);
      await expectUnauthorized(req);
      const res = await invoke("GET", SESSION, req);
      expect(state(res)).toEqual({
        session: null,
        serverNow: NOW.toISOString(),
        expired: true,
      });
      expect(res.cleared).toEqual([
        { name: PARTICIPANT_COOKIE, options: PUBLIC_FLAGS },
      ]);
      expect(res.cookies).toEqual([]);
    }
  );

  it("does not treat a bare cookie name as missing", async () => {
    const req = request({ headers: { cookie: PARTICIPANT_COOKIE } });
    await expectUnauthorized(req);
  });

  it("rejects duplicate valid, empty, and malformed cookies rather than choosing one", async () => {
    const signed = await token();
    for (const second of [signed, "", "invalid", "%"]) {
      const req = request({
        headers: {
          cookie: `${PARTICIPANT_COOKIE}=${signed}; ${PARTICIPANT_COOKIE} =${second}`,
        },
      });
      await expectUnauthorized(req);
      const res = await invoke("GET", SESSION, req);
      expect(res.body).toEqual({
        session: null,
        serverNow: NOW.toISOString(),
        expired: true,
      });
      expect(res.cleared).toEqual([
        { name: PARTICIPANT_COOKIE, options: PUBLIC_FLAGS },
      ]);
      expect(res.cookies).toEqual([]);
    }
  });

  it("reads the unique participant cookie among unrelated cookies without fallback", async () => {
    const signed = await token();
    const req = request({
      headers: {
        cookie: `${COOKIE_NAME}=staff-cookie; ${PARTICIPANT_COOKIE}=${encodeURIComponent(signed)}; other=thing`,
      },
    });
    expect(await readParticipantSession(req)).toMatchObject({
      id: UUID,
      role: "participant",
    });
    await expectUnauthorized(
      request({
        headers: {
          cookie: `${COOKIE_NAME}=valid-staff; eventflow_google_session=valid-google; ${PARTICIPANT_COOKIE}=invalid`,
        },
      })
    );
  });

  it("start replaces invalid/duplicate cookies only after valid same-origin JSON validation", async () => {
    for (const cookie of [
      `${PARTICIPANT_COOKIE}=invalid`,
      `${PARTICIPANT_COOKIE}=invalid; ${PARTICIPANT_COOKIE}=also-invalid`,
      PARTICIPANT_COOKIE,
    ]) {
      const res = await invoke("POST", START, request({ headers: { cookie } }));
      expect(res.statusCode).toBe(200);
      expect(res.cleared).toContainEqual({
        name: PARTICIPANT_COOKIE,
        options: PUBLIC_FLAGS,
      });
      expect(
        await readParticipantSession(
          cookieRequest(participantCookie(res).value)
        )
      ).toEqual(state(res).session);
    }
  });
});

describe("participant CSRF, strict JSON and abuse protection", () => {
  it.each([START, LOGOUT])(
    "rejects cross-origin %s without any cookie mutation",
    async path => {
      const res = await invoke(
        "POST",
        path,
        request({
          headers: {
            origin: "https://attacker.invalid",
            "sec-fetch-site": undefined,
          },
        })
      );
      expect(res.statusCode).toBe(403);
      expect(res.cookies).toEqual([]);
      expect(res.cleared).toEqual([]);
    }
  );

  it.each(["cross-site", "same-site", "none", "invalid"])(
    "rejects Fetch Metadata %s even when Origin is omitted or seemingly valid",
    async fetchSite => {
      for (const path of [START, LOGOUT]) {
        for (const origin of [undefined, ORIGIN]) {
          const res = await invoke(
            "POST",
            path,
            request({
              headers: {
                origin,
                "sec-fetch-site": fetchSite,
              },
            })
          );
          expect(res.statusCode).toBe(403);
          expect(res.cookies).toEqual([]);
          expect(res.cleared).toEqual([]);
        }
      }
    }
  );

  it.each([
    "null",
    "invalid-origin",
    "file://eventflow.example.invalid",
    "http://eventflow.example.invalid",
  ])(
    "rejects invalid/mismatched Origin %s without a trusted same-origin metadata signal",
    async origin => {
      const res = await invoke(
        "POST",
        START,
        request({ headers: { origin, "sec-fetch-site": undefined } })
      );
      expect(res.statusCode).toBe(403);
      expect(res.cookies).toEqual([]);
    }
  );

  it("allows trusted same-origin Preview metadata when the upstream Host is rewritten", async () => {
    const res = await invoke(
      "POST",
      START,
      request({
        headers: {
          host: "127.0.0.1:3000",
          origin: "https://preview.example.invalid",
          "x-forwarded-proto": undefined,
          "sec-fetch-site": "same-origin",
        },
      })
    );
    expect(res.statusCode).toBe(200);
    expect(participantCookie(res).options).toMatchObject(PUBLIC_FLAGS);
  });

  it("retains the shared helper's absent-Origin CLI allowance only without cross-site metadata", async () => {
    const res = await invoke(
      "POST",
      START,
      request({ headers: { origin: undefined, "sec-fetch-site": undefined } })
    );
    expect(res.statusCode).toBe(200);
  });

  it.each([
    undefined,
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/json-evil",
  ])(
    "rejects non-JSON content type %s on both mutations",
    async contentType => {
      for (const path of [START, LOGOUT]) {
        const res = await invoke(
          "POST",
          path,
          request({ headers: { "content-type": contentType } })
        );
        expect(res.statusCode).toBe(415);
        expect(res.cookies).toEqual([]);
        expect(res.cleared).toEqual([]);
      }
    }
  );

  it("accepts JSON with charset and rejects oversized bodies before setting cookies", async () => {
    expect(
      (
        await invoke(
          "POST",
          START,
          request({
            headers: { "content-type": "application/json; charset=utf-8" },
          })
        )
      ).statusCode
    ).toBe(200);
    const res = await invoke(
      "POST",
      START,
      request({ headers: { "content-length": String(256 * 1024 + 1) } })
    );
    expect(res.statusCode).toBe(413);
    expect(res.cookies).toEqual([]);
    expect(res.cleared).toEqual([]);
  });

  it.each([
    undefined,
    null,
    [],
    "",
    42,
    true,
    { id: UUID },
    { role: "participant" },
    { role: "admin" },
    { roles: ["admin"] },
    { ttl: 72000 },
    { claims: {} },
    { expiresAt: "2099-01-01T00:00:00Z" },
    { extra: null },
  ])(
    "accepts only an empty object, never caller-selected claims %j",
    async body => {
      for (const path of [START, LOGOUT]) {
        const res = await invoke("POST", path, request({ body }));
        expect(res.statusCode).toBe(400);
        expect(res.cookies).toEqual([]);
        expect(res.cleared).toEqual([]);
      }
    }
  );

  it("rejects inherited/custom-prototype claims and non-enumerable own properties", async () => {
    const nonEnumerable = Object.defineProperty({}, "role", { value: "admin" });
    for (const body of [
      Object.create({ role: "admin" }),
      nonEnumerable,
      new Date(),
    ]) {
      expect((await invoke("POST", START, request({ body }))).statusCode).toBe(
        400
      );
    }
  });

  it("uses the real existing IP rate limit without using cookies as permission or logging keys", async () => {
    const signed = await token();
    const req = cookieRequest(signed);
    for (let index = 0; index < 60; index++) {
      expect((await invoke("POST", START, req)).statusCode).toBe(200);
    }
    const denied = await invoke("POST", START, req);
    expect(denied.statusCode).toBe(429);
    expect(denied.body).toMatchObject({ code: "RATE_LIMITED" });
    expect(denied.cookies).toEqual([]);
    expect(denied.cleared).toEqual([]);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const retry = await invoke("POST", START, req);
    expect(retry.statusCode).toBe(200);
    expect(state(retry).session!.id).toBe(UUID);
  });
});

describe("participant cookies, switching identities and manual logout", () => {
  it.each(["localhost:3000", "127.0.0.1:3000"])(
    "uses Lax/non-Secure only for explicit local HTTP %s",
    async host => {
      const req = request({
        headers: {
          host,
          origin: `http://${host}`,
          "x-forwarded-proto": undefined,
        },
      });
      const started = await invoke("POST", START, req);
      expect(participantCookie(started).options).toMatchObject(LOCAL_FLAGS);
      const logout = await invoke("POST", LOGOUT, req);
      expect(logout.cleared).toEqual([
        { name: PARTICIPANT_COOKIE, options: LOCAL_FLAGS },
        { name: GOOGLE_TRANSACTION, options: TRANSACTION_FLAGS },
      ]);
    }
  );

  it.each(["development", "production", "test"])(
    "never uses NODE_ENV=%s or req.secure=false to downgrade public TLS",
    async environment => {
      vi.stubEnv("NODE_ENV", environment);
      const started = await invoke(
        "POST",
        START,
        request({
          secure: false,
          protocol: "http",
          headers: { "x-forwarded-proto": undefined },
        })
      );
      expect(participantCookie(started).options).toMatchObject(PUBLIC_FLAGS);
    }
  );

  it.each([
    {
      host: "localhost:3000",
      origin: "https://localhost:3000",
      "x-forwarded-proto": "https",
    },
    {
      host: "127.0.0.1:3000",
      origin: ORIGIN,
      "x-forwarded-proto": "https",
      "x-forwarded-host": HOST,
    },
    { host: "127.0.0.1:3000", origin: ORIGIN, "x-forwarded-proto": "http" },
    {
      host: "127.0.0.1:3000",
      origin: undefined,
      "x-forwarded-proto": "https",
      "x-forwarded-host": HOST,
    },
    {
      host: "127.0.0.1:3000",
      origin: undefined,
      "x-forwarded-proto": "http",
      "x-forwarded-host": "preview.example.invalid",
    },
    {
      host: "localhost.attacker.invalid:3000",
      origin: undefined,
      "x-forwarded-proto": "http",
    },
    {
      host: "127.0.0.1.attacker.invalid",
      origin: undefined,
      "x-forwarded-proto": "http",
    },
  ])("keeps HTTPS/Preview and lookalike hosts Secure %j", async headers => {
    const started = await invoke("POST", START, request({ headers }));
    expect(started.statusCode).toBe(200);
    expect(participantCookie(started).options).toMatchObject(PUBLIC_FLAGS);
  });

  it("uses the first forwarded host/proto and never internal HTTP to downgrade Preview", async () => {
    const started = await invoke(
      "POST",
      START,
      request({
        headers: {
          host: "127.0.0.1:3000",
          origin: undefined,
          "x-forwarded-host": "preview.example.invalid, localhost:3000",
          "x-forwarded-proto": "https, http",
        },
      })
    );
    expect(participantCookie(started).options).toMatchObject(PUBLIC_FLAGS);
  });

  it("start clears Google session, transaction and Manus cookies with their original options", async () => {
    for (const res of [
      await invoke("POST", START),
      await invoke("POST", START, cookieRequest(await token())),
    ]) {
      expect(res.cleared).toEqual([
        { name: "eventflow_google_session", options: GOOGLE_FLAGS },
        { name: "eventflow_local_session", options: GOOGLE_FLAGS },
        { name: COOKIE_NAME, options: PUBLIC_FLAGS },
        { name: GOOGLE_TRANSACTION, options: TRANSACTION_FLAGS },
      ]);
      expect(res.cleared.every(item => item.options.domain === undefined)).toBe(
        true
      );
      expect(forbidden.load).not.toHaveBeenCalled();
    }
  });

  it("manual logout clears the participant and pending transaction, not staff sessions", async () => {
    const signed = await token();
    const res = await invoke("POST", LOGOUT, cookieRequest(signed));
    expect(res.body).toEqual({ success: true });
    expect(res.cookies).toEqual([]);
    expect(res.cleared).toEqual([
      { name: PARTICIPANT_COOKIE, options: PUBLIC_FLAGS },
      { name: GOOGLE_TRANSACTION, options: TRANSACTION_FLAGS },
    ]);
    // Simulate the browser removing the cookie: logout has no token table or
    // server-side grants/revocation memory, as required by this stateless flow.
    expect(await readParticipantSession(request())).toBeNull();
    expect(await readParticipantSession(cookieRequest(signed))).toMatchObject({
      id: UUID,
    });
  });

  it("logout works with absent, malformed, expired or duplicate cookies without minting", async () => {
    const expired = await token({
      iat: Math.floor(Date.now() / 1000) - 72000,
      exp: Math.floor(Date.now() / 1000),
    });
    for (const cookie of [
      undefined,
      `${PARTICIPANT_COOKIE}=invalid`,
      `${PARTICIPANT_COOKIE}=${expired}`,
      `${PARTICIPANT_COOKIE}=one; ${PARTICIPANT_COOKIE}=two`,
    ]) {
      const res = await invoke(
        "POST",
        LOGOUT,
        request({ headers: { cookie } })
      );
      expect(res.body).toEqual({ success: true });
      expect(res.cookies).toEqual([]);
      expect(res.cleared).toEqual([
        { name: PARTICIPANT_COOKIE, options: PUBLIC_FLAGS },
        { name: GOOGLE_TRANSACTION, options: TRANSACTION_FLAGS },
      ]);
    }
  });

  it("the standalone clear helper uses the same attributes, never maxAge or a token", () => {
    const res = response();
    clearParticipantSession(request(), res as unknown as Response);
    expect(res.cleared).toEqual([
      { name: PARTICIPANT_COOKIE, options: PUBLIC_FLAGS },
    ]);
    expect(res.cookies).toEqual([]);
    expect(res.body).toBeUndefined();
  });
});
