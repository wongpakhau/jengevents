import { createHash, createHmac } from "node:crypto";
import type { CookieOptions, Express, Request, Response } from "express";
import {
  createLocalJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// No real DB module or Google network operation is loaded by these tests.
// Real jose signing/verification is retained; the remote JWKS resolver is local.
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  remoteFactory: vi.fn(),
  resolveKey: vi.fn(),
  trustedOrigins: [] as string[],
}));
vi.mock("./_core/googleOrigins", () => ({
  GOOGLE_TRUSTED_ORIGINS: mocks.trustedOrigins,
}));
vi.mock("./db", () => ({
  getUserByOpenId: mocks.read,
  upsertUser: mocks.write,
}));
vi.mock("jose", async importOriginal => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: (...args: unknown[]) => {
      mocks.remoteFactory(...args);
      return mocks.resolveKey;
    },
  };
});

import {
  authenticateGoogleRequest,
  GOOGLE_SESSION_COOKIE,
  registerGoogleAuthRoutes,
} from "./_core/googleAuth";

const ORIGIN = "https://app.example.invalid";
const HOST = new URL(ORIGIN).host;
const SECOND_ORIGIN = "https://other.example.invalid:8443";
const SECOND_HOST = new URL(SECOND_ORIGIN).host;
const START = "/api/auth/google/start";
const CALLBACK = "/api/auth/google/callback";
const LOGOUT = "/api/auth/google/logout";
const TX_COOKIE = "__Host-eventflow_google_transaction";
const CLIENT_ID = "test-client.apps.googleusercontent.com";
const PROJECT_ID = "test-eventflow-project";
const SECRET = "test-only-secret-at-least-32-bytes-never-production";
const KEY = createHmac("sha256", SECRET)
  .update("eventflow-google-session-v1")
  .digest();
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_FLAGS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
};
const SESSION_COOKIE_FLAGS = { ...COOKIE_FLAGS, sameSite: "none" };
const USER = {
  id: 123,
  openId: "google:verified-test-sub",
  name: "Test Person",
  email: "verified@example.invalid",
  loginMethod: "google_direct",
  role: "user",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastSignedIn: new Date(0),
};

type Handler = (req: Request, res: Response) => unknown;
const handlers = new Map<string, Handler>();
const fakeApp = {
  get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler),
  post: (path: string, handler: Handler) =>
    handlers.set(`POST ${path}`, handler),
} as unknown as Express;
registerGoogleAuthRoutes(fakeApp);

function request(overrides: Partial<Request> = {}): Request {
  return {
    query: {},
    ...overrides,
    headers: { host: HOST, "sec-fetch-dest": "document", ...overrides.headers },
  } as Request;
}

function response() {
  const result = {
    cookies: [] as { name: string; value: string; options: CookieOptions }[],
    cleared: [] as { name: string; options: CookieOptions }[],
    headers: {} as Record<string, string>,
    location: "",
    redirectStatus: 0,
    statusCode: 200,
    body: undefined as unknown,
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
    redirect(status: number, location: string) {
      this.redirectStatus = status;
      this.location = location;
      return this;
    },
    status(status: number) {
      this.statusCode = status;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return result;
}

async function invoke(method: string, path: string, req = request()) {
  const res = response();
  const handler = handlers.get(`${method} ${path}`);
  if (!handler) throw new Error("Test route is not registered");
  await handler(req, res as unknown as Response);
  return res;
}

async function begin(returnTo = "/", host = HOST) {
  const res = await invoke(
    "GET",
    START,
    request({ query: { returnTo }, headers: { host } })
  );
  const transaction = res.cookies.find(cookie => cookie.name === TX_COOKIE)!;
  expect(transaction).toBeDefined();
  const { payload } = await jwtVerify(transaction.value, KEY, {
    issuer: "eventflow-google-transaction",
    audience: PROJECT_ID,
  });
  return {
    res,
    cookie: transaction.value,
    state: payload.state as string,
    nonce: payload.nonce as string,
    verifier: payload.verifier as string,
  };
}

type Transaction = Awaited<ReturnType<typeof begin>>;
function callbackRequest(
  transaction: Transaction,
  query: Request["query"] = {},
  host = HOST
) {
  return request({
    headers: { host, cookie: `${TX_COOKIE}=${transaction.cookie}` },
    query: {
      state: transaction.state,
      code: "test-authorization-code",
      ...query,
    },
  });
}

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let fetchMock: ReturnType<typeof vi.fn>;

async function idToken(nonce: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "verified-test-sub",
    iat: now,
    exp: now + 3600,
    nonce,
    email: USER.email,
    email_verified: true,
    name: USER.name,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-google-key" })
    .sign(privateKey);
}

function tokenResponse(token: string) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ id_token: token, access_token: "unused-test-token" }),
  });
}

async function signTransaction(
  transaction: Transaction,
  overrides: Record<string, unknown>,
  header = { alg: "HS256", typ: "oauth-transaction+jwt" }
) {
  return new SignJWT({ ...decodeJwt(transaction.cookie), ...overrides })
    .setProtectedHeader(header)
    .sign(KEY);
}

async function sessionToken(
  overrides: Record<string, unknown> = {},
  key: Uint8Array = KEY,
  header = { alg: "HS256", typ: "JWT" }
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "eventflow-google",
    aud: PROJECT_ID,
    sub: USER.openId,
    iat: now,
    exp: now + SESSION_SECONDS,
    authProvider: "google",
    emailVerified: true,
    ...overrides,
  })
    .setProtectedHeader(header)
    .sign(key);
}

function sessionRequest(cookie: string, extraHeaders: Request["headers"] = {}) {
  return request({
    headers: {
      cookie: `${GOOGLE_SESSION_COOKIE}=${cookie}`,
      ...extraHeaders,
    },
  });
}

function expectError(res: Awaited<ReturnType<typeof invoke>>, code: string) {
  expect(res.location).toBe(`/?authError=${code}`);
  expect(res.redirectStatus).toBe(303);
  expect(
    res.cookies.some(cookie => cookie.name === GOOGLE_SESSION_COOKIE)
  ).toBe(false);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  const resolver = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "RS256", kid: "test-google-key", use: "sig" }],
  });
  mocks.resolveKey.mockImplementation(resolver);
});

beforeEach(() => {
  mocks.trustedOrigins.splice(
    0,
    mocks.trustedOrigins.length,
    ORIGIN,
    SECOND_ORIGIN
  );
  // Override BOTH naming conventions so no stored credentials are used.
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-only-client-secret");
  vi.stubEnv("Google_CLIENT_ID", "");
  vi.stubEnv("Google_CLIENT_SECRET", "");
  vi.stubEnv("MANUS_PROJECT_ID", PROJECT_ID);
  vi.stubEnv("MANUS_JWT_SECRET", SECRET);
  vi.stubEnv("OWNER_OPEN_ID", USER.openId);
  mocks.read
    .mockReset()
    .mockImplementation(async (openId: string) => ({ ...USER, openId }));
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.resolveKey.mockClear();
  fetchMock = vi.fn().mockRejectedValue(new Error("Mock network unavailable"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Google route registration and configuration", () => {
  it("registers the four exact routes and never allows GET logout", () => {
    expect([...handlers.keys()]).toEqual([
      "GET /api/auth/google/status",
      `GET ${START}`,
      `GET ${CALLBACK}`,
      `POST ${LOGOUT}`,
    ]);
  });

  it("reports only configured and loginPath, not secrets", async () => {
    const res = await invoke("GET", "/api/auth/google/status");
    expect(res.body).toEqual({ configured: true, loginPath: START });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("ships with no production origins and fails closed when the list is empty", async () => {
    const actual = await vi.importActual<
      typeof import("./_core/googleOrigins")
    >("./_core/googleOrigins");
    expect(actual.GOOGLE_TRUSTED_ORIGINS).toEqual([]);
    mocks.trustedOrigins.length = 0;
    expect((await invoke("GET", "/api/auth/google/status")).body).toEqual({
      configured: false,
      loginPath: START,
    });
    expectError(await invoke("GET", START), "configuration");
    expectError(await invoke("GET", CALLBACK), "configuration");
    await expect(
      authenticateGoogleRequest(sessionRequest(await sessionToken()))
    ).rejects.toThrow("Invalid Google session");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([
    "http://app.example.invalid",
    "https://*.example.invalid",
    "https://app.example.invalid/",
    "https://app.example.invalid/path",
    "https://app.example.invalid?query=1",
    "https://app.example.invalid#fragment",
    "https://user:pass@app.example.invalid",
    "https://app.example.invalid:443",
    "HTTPS://app.example.invalid",
    " https://app.example.invalid",
    "not-a-url",
  ])(
    "rejects the entire list if an entry is not a canonical HTTPS origin: %s",
    async invalid => {
      mocks.trustedOrigins.push(invalid);
      expect((await invoke("GET", "/api/auth/google/status")).body).toEqual({
        configured: false,
        loginPath: START,
      });
      expectError(await invoke("GET", START), "configuration");
      await expect(
        authenticateGoogleRequest(sessionRequest(await sessionToken()))
      ).rejects.toThrow("Invalid Google session");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.read).not.toHaveBeenCalled();
    }
  );

  it("reports unconfigured on an unknown request host even when credentials exist", async () => {
    const res = await invoke(
      "GET",
      "/api/auth/google/status",
      request({
        headers: { host: "attacker.invalid", "x-forwarded-host": HOST },
      })
    );
    expect(res.body).toEqual({ configured: false, loginPath: START });
  });

  it.each([
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MANUS_PROJECT_ID",
    "MANUS_JWT_SECRET",
  ])("fails safely when %s is missing", async name => {
    vi.stubEnv(name, "");
    const status = await invoke("GET", "/api/auth/google/status");
    expect(status.body).toEqual({ configured: false, loginPath: START });
    const start = await invoke("GET", START);
    expectError(start, "configuration");
    expect(start.cookies).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives a domain-separated key from a managed secret of unspecified length", async () => {
    vi.stubEnv("MANUS_JWT_SECRET", "managed-test-key");
    expect((await invoke("GET", "/api/auth/google/status")).body).toEqual({
      configured: true,
      loginPath: START,
    });
  });

  it("supports the provided mixed-case Google environment names", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", undefined);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", undefined);
    vi.stubEnv("Google_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("Google_CLIENT_SECRET", "test-only-client-secret");
    expect((await invoke("GET", "/api/auth/google/status")).body).toEqual({
      configured: true,
      loginPath: START,
    });
  });

  it("uses only Google remote JWKS and sets its timeout", () => {
    const [url, options] = mocks.remoteFactory.mock.calls[0]!;
    expect(url.toString()).toBe("https://www.googleapis.com/oauth2/v3/certs");
    expect(options).toMatchObject({ timeoutDuration: 10_000 });
  });
});

describe("Google start: browser CSRF binding, PKCE and safe redirects", () => {
  it("uses independent 256-bit state/nonce/verifier and correct S256 PKCE", async () => {
    const first = await begin("/join");
    const second = await begin("/access");
    const authorization = new URL(first.res.location);
    expect(authorization.origin + authorization.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    const params = authorization.searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(`${ORIGIN}${CALLBACK}`);
    expect(params.get("scope")).toBe("openid email profile");
    expect(params.get("prompt")).toBe("select_account");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("state")).toBe(first.state);
    expect(params.get("nonce")).toBe(first.nonce);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(
      createHash("sha256").update(first.verifier).digest("base64url")
    );
    expect(params.has("code_verifier")).toBe(false);
    expect(params.has("client_secret")).toBe(false);
    for (const value of [first.state, first.nonce, first.verifier]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(value, "base64url").length).toBe(32);
    }
    expect(new Set([first.state, first.nonce, first.verifier]).size).toBe(3);
    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.verifier).not.toBe(second.verifier);
  });

  it("signs a 10-minute, host-only, Secure HttpOnly Lax browser transaction", async () => {
    const transaction = await begin();
    const cookie = transaction.res.cookies[0]!;
    expect(cookie.name).toBe(TX_COOKIE);
    expect(cookie.options).toEqual({ ...COOKIE_FLAGS, maxAge: 600_000 });
    expect(cookie.options.domain).toBeUndefined();
    const payload = decodeJwt(cookie.value);
    expect(payload.exp! - payload.iat!).toBe(600);
    expect(payload.redirectUri).toBe(`${ORIGIN}${CALLBACK}`);
    expect(transaction.res.headers).toMatchObject({
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
  });

  it("uses the matching explicitly configured second-origin callback", async () => {
    const transaction = await begin("/access", SECOND_HOST);
    const redirectUri = `${SECOND_ORIGIN}${CALLBACK}`;
    expect(
      new URL(transaction.res.location).searchParams.get("redirect_uri")
    ).toBe(redirectUri);
    expect(decodeJwt(transaction.cookie).redirectUri).toBe(redirectUri);

    tokenResponse(await idToken(transaction.nonce));
    const res = await invoke(
      "GET",
      CALLBACK,
      callbackRequest(transaction, {}, SECOND_HOST)
    );
    expect(res.location).toBe(`${SECOND_ORIGIN}/access`);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0]!;
    expect(options.body.get("redirect_uri")).toBe(redirectUri);
  });

  it.each(["/", "/join", "/access"])("allows returnTo %s", async path => {
    expect(decodeJwt((await begin(path)).cookie).returnTo).toBe(path);
  });

  it.each([
    "https://attacker.invalid/",
    "//attacker.invalid/",
    "/\\attacker.invalid",
    "/join?next=https://attacker.invalid",
    "/access#fragment",
    "/admin",
    "/%2f%2fattacker.invalid",
  ])("does not allow open redirect returnTo %s", async path => {
    expect(decodeJwt((await begin(path)).cookie).returnTo).toBe("/");
  });

  it("does not accept arrays or caller-selected redirectUri", async () => {
    const res = await invoke(
      "GET",
      START,
      request({
        query: {
          returnTo: ["/join", "/access"],
          redirectUri: "https://attacker.invalid",
        },
      })
    );
    expect(decodeJwt(res.cookies[0]!.value).returnTo).toBe("/");
    expect(new URL(res.location).searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}${CALLBACK}`
    );
  });

  it.each(["iframe", "frame", "empty"])(
    "rejects non-tab fetch destination %s",
    async destination => {
      const res = await invoke(
        "GET",
        START,
        request({ headers: { "sec-fetch-dest": destination } })
      );
      expectError(res, "top_level_required");
      expect(res.cookies).toEqual([]);
    }
  );

  it("does not let a forwarded host choose or override an origin", async () => {
    const rejected = await invoke(
      "GET",
      START,
      request({
        headers: { host: "attacker.invalid", "x-forwarded-host": HOST },
      })
    );
    expectError(rejected, "top_level_required");
    expect(rejected.cookies).toEqual([]);
    const accepted = await invoke(
      "GET",
      START,
      request({
        headers: { host: HOST, "x-forwarded-host": SECOND_HOST },
      })
    );
    expect(new URL(accepted.location).searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}${CALLBACK}`
    );
  });

  it.each([
    "eventflow-fyezorm9.manus.space",
    "jengevents.com",
    "attacker.invalid",
    "sub.app.example.invalid",
    "app.example.invalid.attacker.invalid",
    "app.example.invalid:8443",
    "other.example.invalid:8443:443",
    `${HOST}, attacker.invalid`,
    "app.example.invalid@attacker.invalid",
  ])(
    "rejects an unconfigured host %s with only a same-site relative error",
    async host => {
      const headers = { host, "x-forwarded-host": HOST };
      const start = await invoke("GET", START, request({ headers }));
      expectError(start, "top_level_required");
      expect(start.cookies).toEqual([]);
      const callback = await invoke("GET", CALLBACK, request({ headers }));
      expectError(callback, "top_level_required");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    }
  );

  it("accepts only equivalent default port and case for a configured host", async () => {
    const res = await invoke(
      "GET",
      START,
      request({
        headers: { host: `${HOST.toUpperCase()}:443` },
      })
    );
    expect(new URL(res.location).searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}${CALLBACK}`
    );
  });
});

describe("Google callback: verify state before any token exchange", () => {
  it("rejects a valid bound transaction on an unknown host before any exchange", async () => {
    const transaction = await begin();
    const req = callbackRequest(transaction, {}, "attacker.invalid");
    req.headers["x-forwarded-host"] = HOST;
    tokenResponse(await idToken(transaction.nonce));
    expectError(await invoke("GET", CALLBACK, req), "top_level_required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([
    ["missing cookie", undefined],
    ["empty cookie", `${TX_COOKIE}=`],
    ["bad signature", `${TX_COOKIE}=not-a-jwt`],
    ["malformed encoding", `${TX_COOKIE}=%zz`],
  ])(
    "rejects %s without contacting Google or the database",
    async (_name, cookie) => {
      const res = await invoke(
        "GET",
        CALLBACK,
        request({
          headers: { cookie },
          query: { state: "attacker-state", code: "sensitive-code" },
        })
      );
      expectError(res, "state_invalid");
      expect(res.cleared).toContainEqual({
        name: TX_COOKIE,
        options: SESSION_COOKIE_FLAGS,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    }
  );

  it("rejects state copied from another browser's signed transaction", async () => {
    const first = await begin();
    const second = await begin();
    const res = await invoke(
      "GET",
      CALLBACK,
      callbackRequest(first, { state: second.state })
    );
    expectError(res, "state_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a callback completed on a different trusted host", async () => {
    const transaction = await begin("/access", SECOND_HOST);
    const res = await invoke(
      "GET",
      CALLBACK,
      callbackRequest(transaction, {}, HOST)
    );
    expectError(res, "state_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a rejected callback on the trusted custom domain", async () => {
    const res = await invoke(
      "GET",
      CALLBACK,
      request({ headers: { host: SECOND_HOST } })
    );
    expect(res.location).toBe("/?authError=state_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate transaction cookies", async () => {
    const transaction = await begin();
    const req = callbackRequest(transaction);
    req.headers.cookie += `; ${TX_COOKIE}=${transaction.cookie}`;
    expectError(await invoke("GET", CALLBACK, req), "state_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, ["one", "two"], "wrong-state"])(
    "rejects malformed query state %s",
    async state => {
      const transaction = await begin();
      const req = callbackRequest(transaction);
      req.query.state = state;
      expectError(await invoke("GET", CALLBACK, req), "state_invalid");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["expired transaction", { exp: 1 }],
    ["wrong issuer", { iss: "eventflow-google" }],
    ["wrong audience", { aud: "other-project" }],
    [
      "wrong redirect binding",
      { redirectUri: "https://attacker.invalid/callback" },
    ],
    ["wrong client binding", { clientId: "other-client" }],
    ["invalid nonce", { nonce: "short" }],
    ["invalid verifier", { verifier: "short" }],
    ["open redirect in signed transaction", { returnTo: "//attacker.invalid" }],
    ["missing expiry", { exp: undefined }],
    ["missing issued-at", { iat: undefined }],
    ["excessive lifetime", { exp: Math.floor(Date.now() / 1000) + 86_400 }],
  ])("rejects %s before exchanging code", async (_name, overrides) => {
    const transaction = await begin();
    transaction.cookie = await signTransaction(transaction, overrides);
    expectError(
      await invoke("GET", CALLBACK, callbackRequest(transaction)),
      "state_invalid"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rejects a transaction with the session JWT type", async () => {
    const transaction = await begin();
    transaction.cookie = await signTransaction(
      transaction,
      {},
      { alg: "HS256", typ: "JWT" }
    );
    expectError(
      await invoke("GET", CALLBACK, callbackRequest(transaction)),
      "state_invalid"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles user cancellation only after verified browser binding", async () => {
    const transaction = await begin();
    const res = await invoke(
      "GET",
      CALLBACK,
      callbackRequest(transaction, {
        error: "access_denied",
        error_description: "private account information",
      })
    );
    expectError(res, "google_cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    const unbound = await invoke(
      "GET",
      CALLBACK,
      request({ query: { error: "access_denied" } })
    );
    expectError(unbound, "state_invalid");
  });

  it("does not reflect arbitrary provider errors", async () => {
    const transaction = await begin();
    expectError(
      await invoke(
        "GET",
        CALLBACK,
        callbackRequest(transaction, {
          error: "attacker-controlled-token-value",
        })
      ),
      "token_invalid"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "", ["one", "two"]])(
    "rejects a malformed/missing code %s",
    async code => {
      const transaction = await begin();
      expectError(
        await invoke("GET", CALLBACK, callbackRequest(transaction, { code })),
        "token_invalid"
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe("Google callback: OIDC signature, issuer, audience, nonce and verified email", () => {
  it.each(["https://accounts.google.com", "accounts.google.com"])(
    "accepts the verified Google issuer %s and persists only google:<sub>",
    async issuer => {
      const transaction = await begin("/join");
      tokenResponse(
        await idToken(transaction.nonce, {
          iss: issuer,
          role: "admin",
          owner: true,
        })
      );
      const req = callbackRequest(transaction, {
        email: "unverified-owner@example.invalid",
        role: "admin",
        returnTo: "//attacker.invalid",
      });
      const res = await invoke("GET", CALLBACK, req);
      expect(res.location).toBe(`${ORIGIN}/join`);
      expect(res.redirectStatus).toBe(303);
      expect(mocks.resolveKey).toHaveBeenCalled();
      expect(mocks.write).toHaveBeenCalledOnce();
      expect(mocks.write).toHaveBeenCalledWith({
        openId: USER.openId,
        name: USER.name,
        email: USER.email,
        loginMethod: "google_direct",
        role: "user", // Even when OWNER_OPEN_ID exactly matches the Google ID.
        lastSignedIn: expect.any(Date),
      });
      expect(mocks.read).toHaveBeenCalledWith(USER.openId);
      // There is no email lookup/automatic merge into an existing Manus user.
      expect(
        mocks.read.mock.calls.every(([id]) => id.startsWith("google:"))
      ).toBe(true);
      expect(res.cleared).toContainEqual({
        name: TX_COOKIE,
        options: SESSION_COOKIE_FLAGS,
      });
      const session = res.cookies.find(
        cookie => cookie.name === GOOGLE_SESSION_COOKIE
      )!;
      expect(session.options).toEqual({
        ...SESSION_COOKIE_FLAGS,
        maxAge: SESSION_SECONDS * 1000,
      });
      expect(session.options.domain).toBeUndefined();
      const { payload } = await jwtVerify(session.value, KEY, {
        issuer: "eventflow-google",
        audience: PROJECT_ID,
        algorithms: ["HS256"],
      });
      expect(payload.sub).toBe(USER.openId);
      expect(payload.authProvider).toBe("google");
      expect(payload.emailVerified).toBe(true);
      expect(payload.exp! - payload.iat!).toBe(SESSION_SECONDS);
      expect(payload.role).toBeUndefined();
      expect(payload.email).toBeUndefined();
      expect(payload.access_token).toBeUndefined();
      expect(
        await authenticateGoogleRequest(sessionRequest(session.value))
      ).toEqual({
        ...USER,
        authProvider: "google",
        emailVerified: true,
      });
    }
  );

  it("clears the transaction before network and exchanges the bound PKCE verifier", async () => {
    const transaction = await begin();
    const token = await idToken(transaction.nonce);
    const req = callbackRequest(transaction, {
      redirectUri: "https://attacker.invalid",
    });
    const res = response();
    fetchMock.mockImplementation(async () => {
      expect(res.cleared).toContainEqual({
        name: TX_COOKIE,
        options: SESSION_COOKIE_FLAGS,
      });
      return { ok: true, json: async () => ({ id_token: token }) };
    });
    await handlers.get(`GET ${CALLBACK}`)!(req, res as unknown as Response);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(Object.fromEntries(options.body.entries())).toEqual({
      grant_type: "authorization_code",
      code: "test-authorization-code",
      client_id: CLIENT_ID,
      client_secret: "test-only-client-secret",
      redirect_uri: `${ORIGIN}${CALLBACK}`,
      code_verifier: transaction.verifier,
    });
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.invalid" }],
    ["wrong audience", { aud: "other-client" }],
    ["wrong nonce", { nonce: "A".repeat(43) }],
    ["missing nonce", { nonce: undefined }],
    ["unverified email", { email_verified: false }],
    ["string email_verified", { email_verified: "true" }],
    ["numeric email_verified", { email_verified: 1 }],
    ["missing email_verified", { email_verified: undefined }],
    ["missing email", { email: undefined }],
    ["invalid email", { email: "not-an-email" }],
    ["missing subject", { sub: undefined }],
    ["empty subject", { sub: "" }],
    ["subject exceeds database identifier limit", { sub: "x".repeat(58) }],
    ["expired ID token", { exp: 1 }],
    ["missing expiry", { exp: undefined }],
    ["missing issued-at", { iat: undefined }],
    ["wrong authorized party", { azp: "other-client" }],
    ["ambiguous multi-audience token", { aud: [CLIENT_ID, "other-client"] }],
  ])(
    "rejects %s without issuing a session or writing data",
    async (_name, overrides) => {
      const transaction = await begin();
      tokenResponse(await idToken(transaction.nonce, overrides));
      const res = await invoke("GET", CALLBACK, callbackRequest(transaction));
      expectError(res, "token_invalid");
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.read).not.toHaveBeenCalled();
    }
  );

  it("rejects an HS256 forged Google ID token despite correct claims", async () => {
    const transaction = await begin();
    const genuine = await idToken(transaction.nonce);
    const forged = await new SignJWT(decodeJwt(genuine))
      .setProtectedHeader({ alg: "HS256" })
      .sign(KEY);
    tokenResponse(forged);
    expectError(
      await invoke("GET", CALLBACK, callbackRequest(transaction)),
      "token_invalid"
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rejects an RS256 token signed by an attacker key", async () => {
    const transaction = await begin();
    const attacker = await generateKeyPair("RS256");
    const genuine = await idToken(transaction.nonce);
    const forged = await new SignJWT(decodeJwt(genuine))
      .setProtectedHeader({ alg: "RS256", kid: "test-google-key" })
      .sign(attacker.privateKey);
    tokenResponse(forged);
    expectError(
      await invoke("GET", CALLBACK, callbackRequest(transaction)),
      "token_invalid"
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([
    "timeout",
    "http error",
    "malformed JSON",
    "missing id_token",
    "invalid id_token",
  ])("fails safely on token endpoint %s", async scenario => {
    const transaction = await begin();
    if (scenario === "timeout")
      fetchMock.mockRejectedValue(
        new DOMException("sensitive-code", "TimeoutError")
      );
    if (scenario === "http error") fetchMock.mockResolvedValue({ ok: false });
    if (scenario === "malformed JSON")
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error("sensitive-token");
        },
      });
    if (scenario === "missing id_token")
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "sensitive-token" }),
      });
    if (scenario === "invalid id_token") tokenResponse("not-a-jwt");
    expectError(
      await invoke("GET", CALLBACK, callbackRequest(transaction)),
      "token_invalid"
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("fails closed when JWKS verification fails", async () => {
    const transaction = await begin();
    tokenResponse(await idToken(transaction.nonce));
    mocks.resolveKey.mockRejectedValueOnce(new Error("Mock JWKS timeout"));
    expectError(
      await invoke("GET", CALLBACK, callbackRequest(transaction)),
      "token_invalid"
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("does not issue a session if upsert fails", async () => {
    const transaction = await begin();
    tokenResponse(await idToken(transaction.nonce));
    mocks.write.mockRejectedValue(new Error("database details must not leak"));
    expectError(
      await invoke("GET", CALLBACK, callbackRequest(transaction)),
      "storage_error"
    );
  });

  it.each([
    undefined,
    { ...USER, openId: "manus-user" },
    { ...USER, loginMethod: "manus" },
  ])(
    "does not issue a session if persisted user cannot be matched",
    async persisted => {
      const transaction = await begin();
      tokenResponse(await idToken(transaction.nonce));
      mocks.read.mockResolvedValue(persisted);
      expectError(
        await invoke("GET", CALLBACK, callbackRequest(transaction)),
        "storage_error"
      );
    }
  );
});

describe("Google sessions: cookie-only, independent JWT and fail-closed DB reads", () => {
  it("rejects a signed Google session on an unknown host, including forged forwarded host", async () => {
    const token = await sessionToken();
    await expect(
      authenticateGoogleRequest(
        sessionRequest(token, {
          host: "attacker.invalid",
          "x-forwarded-host": HOST,
        })
      )
    ).rejects.toThrow("Invalid Google session");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("returns null only when the Google cookie is absent, never using Manus/Bearer", async () => {
    vi.stubEnv("MANUS_JWT_SECRET", "");
    const req = request({
      headers: {
        cookie: "webdev_app_session=manus-jwt; app_session_id=another-jwt",
        authorization: "Bearer another-token",
      },
    });
    expect(await authenticateGoogleRequest(req)).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-jwt", "%zz"])(
    "throws for present invalid cookie %s, not falling back",
    async value => {
      const req = sessionRequest(value, {
        authorization: "Bearer valid-manus-token",
      });
      req.headers.cookie += "; webdev_app_session=valid-manus-cookie";
      await expect(authenticateGoogleRequest(req)).rejects.toMatchObject({
        statusCode: 403,
        message: "Invalid Google session",
      });
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    }
  );

  it("throws for duplicated session cookies", async () => {
    const token = await sessionToken();
    const req = sessionRequest(token);
    req.headers.cookie += `; ${GOOGLE_SESSION_COOKIE}=${token}`;
    await expect(authenticateGoogleRequest(req)).rejects.toThrow(
      "Invalid Google session"
    );
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("validates the cookie and reads only the matching Google DB user", async () => {
    const token = await sessionToken({
      email: "untrusted@example.invalid",
      role: "admin",
    });
    const authenticated = await authenticateGoogleRequest(
      sessionRequest(token)
    );
    expect(authenticated).toEqual({
      ...USER,
      authProvider: "google",
      emailVerified: true,
    });
    expect(authenticated?.role).toBe("user");
    expect(authenticated?.email).toBe(USER.email);
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledWith(USER.openId);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong issuer", { iss: "manus" }],
    ["wrong audience", { aud: "another-project" }],
    ["Manus subject", { sub: "manus-user" }],
    ["empty Google subject", { sub: "google:" }],
    ["missing expiry", { exp: undefined }],
    ["expired session", { exp: 1 }],
    ["missing issued-at", { iat: undefined }],
    [
      "too-long lifetime",
      { exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS + 600 },
    ],
    ["future issued-at", { iat: Math.floor(Date.now() / 1000) + 600 }],
    ["wrong provider", { authProvider: "manus" }],
    ["missing provider", { authProvider: undefined }],
    ["unverified email", { emailVerified: false }],
    ["string verified flag", { emailVerified: "true" }],
  ])("fails closed for %s before DB access", async (_name, overrides) => {
    const token = await sessionToken(overrides);
    await expect(
      authenticateGoogleRequest(sessionRequest(token))
    ).rejects.toThrow("Invalid Google session");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rejects a forged signature", async () => {
    const token = await sessionToken(
      {},
      new TextEncoder().encode("attacker-secret-at-least-32-bytes-long")
    );
    await expect(
      authenticateGoogleRequest(sessionRequest(token))
    ).rejects.toThrow("Invalid Google session");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("rejects a transaction JWT even if signed with the shared secret", async () => {
    const token = await sessionToken({}, KEY, {
      alg: "HS256",
      typ: "oauth-transaction+jwt",
    });
    await expect(
      authenticateGoogleRequest(sessionRequest(token))
    ).rejects.toThrow("Invalid Google session");
  });

  it.each([
    undefined,
    { ...USER, openId: "manus-user" },
    { ...USER, loginMethod: "google" },
  ])(
    "fails closed for a missing/mismatched/non-direct DB identity",
    async user => {
      mocks.read.mockResolvedValue(user);
      await expect(
        authenticateGoogleRequest(sessionRequest(await sessionToken()))
      ).rejects.toThrow("Invalid Google session");
      expect(mocks.write).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("sanitizes DB failures without syncing or logging private data", async () => {
    mocks.read.mockRejectedValue(new Error("private database details"));
    await expect(
      authenticateGoogleRequest(sessionRequest(await sessionToken()))
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Invalid Google session",
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("fails closed when configuration disappears but a cookie is present", async () => {
    const token = await sessionToken();
    vi.stubEnv("MANUS_JWT_SECRET", "");
    await expect(
      authenticateGoogleRequest(sessionRequest(token))
    ).rejects.toThrow("Invalid Google session");
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

describe("Google logout: POST same-origin JSON CSRF policy", () => {
  const logoutHeaders = {
    origin: ORIGIN,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };

  it("clears Google and Manus host-only cookies and returns ok", async () => {
    const res = await invoke(
      "POST",
      LOGOUT,
      request({ headers: logoutHeaders })
    );
    expect(res.body).toEqual({ ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.cleared).toEqual([
      { name: GOOGLE_SESSION_COOKIE, options: SESSION_COOKIE_FLAGS },
      { name: "webdev_app_session", options: SESSION_COOKIE_FLAGS },
      { name: TX_COOKIE, options: SESSION_COOKIE_FLAGS },
    ]);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a later callback after the browser has removed its transaction", async () => {
    const transaction = await begin();
    const logout = await invoke(
      "POST",
      LOGOUT,
      request({
        headers: {
          ...logoutHeaders,
          cookie: `${TX_COOKIE}=${transaction.cookie}`,
        },
      })
    );
    expect(logout.cleared).toContainEqual({
      name: TX_COOKIE,
      options: SESSION_COOKIE_FLAGS,
    });
    const callback = await invoke(
      "GET",
      CALLBACK,
      request({ query: { state: transaction.state, code: "unused" } })
    );
    expectError(callback, "state_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    // This models a subsequent request, not a callback already sent in parallel.
  });

  it("allows same-origin JSON logout on a second configured origin", async () => {
    const res = await invoke(
      "POST",
      LOGOUT,
      request({
        headers: {
          ...logoutHeaders,
          host: SECOND_HOST,
          origin: SECOND_ORIGIN,
        },
      })
    );
    expect(res.body).toEqual({ ok: true });
    expect(res.cleared).toHaveLength(3);
  });

  it.each([
    ["missing Origin", { origin: undefined }],
    ["cross-site Origin", { origin: "https://attacker.invalid" }],
    ["sibling-domain Origin", { origin: "https://sibling.manus.space" }],
    ["null Origin", { origin: "null" }],
    ["wrong Host", { host: "attacker.invalid" }],
    ["HTML form body", { "content-type": "application/x-www-form-urlencoded" }],
    ["text body", { "content-type": "text/plain" }],
    ["missing Content-Type", { "content-type": undefined }],
    ["cross-site Fetch Metadata", { "sec-fetch-site": "cross-site" }],
  ])("rejects %s without clearing cookies", async (_name, headers) => {
    const res = await invoke(
      "POST",
      LOGOUT,
      request({ headers: { ...logoutHeaders, ...headers } })
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ ok: false });
    expect(res.cleared).toEqual([]);
  });

  it("allows a same-origin JSON content type with charset", async () => {
    const res = await invoke(
      "POST",
      LOGOUT,
      request({
        headers: {
          ...logoutHeaders,
          "content-type": "application/json; charset=utf-8",
        },
      })
    );
    expect(res.body).toEqual({ ok: true });
  });
});
