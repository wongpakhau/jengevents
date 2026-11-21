import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import type { Server } from "node:http";
import superjson from "superjson";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { COOKIE_NAME } from "../shared/const";
import { PARTICIPANT_COOKIE } from "../shared/participant";

// No real database, platform authentication, or Google network calls are used.
const mocks = vi.hoisted(() => ({
  read: vi.fn(() => {
    throw new Error("Unexpected DB read");
  }),
  write: vi.fn(() => {
    throw new Error("Unexpected DB write");
  }),
  authenticate: vi.fn().mockRejectedValue(new Error("No test staff identity")),
  trustedOrigins: [] as string[],
}));
vi.mock("./db", () => ({
  getUserByOpenId: mocks.read,
  upsertUser: mocks.write,
}));
vi.mock("./_core/sdk", () => ({
  sdk: { authenticateRequest: mocks.authenticate },
}));
vi.mock("./_core/googleOrigins", () => ({
  GOOGLE_TRUSTED_ORIGINS: mocks.trustedOrigins,
}));

import { createContext } from "./_core/context";
import { registerGoogleAuthRoutes } from "./_core/googleAuth";
import { registerParticipantAuthRoutes } from "./_core/participantAuth";
import { appRouter, type AppRouter } from "./routers";

const TX_COOKIE = "__Host-eventflow_google_transaction";
const GOOGLE_COOKIE = "eventflow_google_session";
const allCookies = `${COOKIE_NAME}=test; ${GOOGLE_COOKIE}=test; ${TX_COOKIE}=test; ${PARTICIPANT_COOKIE}=test`;
let appOrigin: string;
let server: Server;
let base: string;

beforeAll(async () => {
  // Deliberately fail before opening a listener if a DB URL leaks into the test.
  expect(process.env.DATABASE_URL).toBeUndefined();
  vi.stubEnv("MANUS_PROJECT_ID", "logout-http-test-project");
  vi.stubEnv("MANUS_JWT_SECRET", "logout-http-test-secret-not-production");
  vi.stubEnv("GOOGLE_CLIENT_ID", "logout-test-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "logout-test-secret");
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerParticipantAuthRoutes(app);
  registerGoogleAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({ router: appRouter, createContext })
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Model a TLS-terminating proxy without relying on Node fetch to set Host.
  appOrigin = base.replace("http:", "https:");
  mocks.trustedOrigins.push(appOrigin);
  const localFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const target = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    );
    if (target.origin !== base)
      throw new Error("External network is forbidden in this test");
    return localFetch(input, init);
  });
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  mocks.read.mockClear();
  mocks.write.mockClear();
  mocks.authenticate.mockClear();
});

afterEach(() => {
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
});

function cookieHeader(response: Response, name: string): string {
  const headers = response.headers
    .getSetCookie()
    .filter(value => value.startsWith(`${name}=`));
  expect(headers).toHaveLength(1);
  return headers[0]!;
}

function expectCleared(
  response: Response,
  name: string,
  sameSite: "Lax" | "None"
) {
  const header = cookieHeader(response, name);
  expect(header).toMatch(new RegExp(`^${name}=;`));
  expect(header).toMatch(/(?:^|;\s*)Path=\//i);
  const expires = /(?:^|;\s*)Expires=([^;]+)/i.exec(header)?.[1];
  expect(expires).toBeDefined();
  expect(Date.parse(expires!)).toBeLessThan(Date.now());
  expect(header).toMatch(/(?:^|;\s*)HttpOnly(?:;|$)/i);
  expect(header).toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
  expect(header).toMatch(
    new RegExp(`(?:^|;\\s*)SameSite=${sameSite}(?:;|$)`, "i")
  );
  expect(header).not.toMatch(/(?:^|;\s*)Domain=/i);
}

async function rawLogout(headers: Record<string, string>, body: BodyInit) {
  return fetch(`${base}/api/trpc/auth.logout`, {
    method: "POST",
    headers: { cookie: allCookies, ...headers },
    body,
  });
}

const jsonInput = JSON.stringify({
  json: null,
  meta: { values: ["undefined"] },
});

async function beginGoogleTransaction() {
  const start = await fetch(`${base}/api/auth/google/start`, {
    headers: { "sec-fetch-dest": "document" },
    redirect: "manual",
  });
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state"
  );
  expect(state).toBeTruthy();
  const transaction = cookieHeader(start, TX_COOKIE).split(";", 1)[0]!;
  expect(transaction).not.toBe(`${TX_COOKIE}=`);
  return { state: state!, transaction };
}

async function expectLaterCallbackRejected(state: string) {
  // The simulated browser has processed Set-Cookie and sends no transaction.
  // This does not claim to revoke requests that were already sent in parallel.
  const callback = await fetch(
    `${base}/api/auth/google/callback?${new URLSearchParams({ state, code: "unused" })}`,
    { redirect: "manual" }
  );
  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe("/?authError=state_invalid");
  expect(
    callback.headers
      .getSetCookie()
      .some(value => value.startsWith(`${GOOGLE_COOKIE}=`))
  ).toBe(false);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
}

describe("auth.logout HTTP CSRF protection", () => {
  it("accepts the real same-origin tRPC httpBatchLink JSON mutation", async () => {
    let response: Response | undefined;
    let requestUrl = "";
    let contentType = "";
    const client = createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${base}/api/trpc`,
          transformer: superjson,
          async fetch(input, init) {
            requestUrl = String(input);
            const headers = new Headers(init?.headers);
            contentType = headers.get("content-type") ?? "";
            headers.set("origin", base);
            headers.set("sec-fetch-site", "same-origin");
            headers.set("cookie", allCookies);
            response = await fetch(input, { ...init, headers });
            return response;
          },
        }),
      ],
    });
    expect(await client.auth.logout.mutate()).toEqual({ success: true });
    expect(requestUrl).toContain("batch=1");
    expect(contentType).toBe("application/json");
    expect(response?.status).toBe(200);
    expectCleared(response!, COOKIE_NAME, "None");
    expectCleared(response!, GOOGLE_COOKIE, "None");
    expectCleared(response!, TX_COOKIE, "None");
    // This local HTTP test request uses the existing participant local flags.
    const participant = cookieHeader(response!, PARTICIPANT_COOKIE);
    expect(participant).toContain("SameSite=Lax");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([
    [
      "cross-site metadata",
      { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" },
    ],
    ["no Fetch Metadata", { origin: "https://attacker.invalid" }],
    ["no Origin", { "sec-fetch-site": "cross-site" }],
  ])(
    "rejects a cross-site multipart HTML form with %s",
    async (_label, headers) => {
      const form = new FormData();
      form.append("input", "{}");
      const res = await rawLogout(headers, form);
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
      const result = await res.json();
      // Confirm this form reached the procedure's check rather than an unrelated parser failure.
      expect(result.error.json.data.code).toBe("FORBIDDEN");
      expect(result.error.json.message).toBe("不接受跨站或非 JSON 登出請求");
    }
  );

  it.each([
    [
      "same-origin multipart",
      { origin: "BASE", "sec-fetch-site": "same-origin" },
      "multipart",
    ],
    [
      "urlencoded form",
      {
        origin: "BASE",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      "form",
    ],
    [
      "text/plain",
      {
        origin: "BASE",
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain",
      },
      "form",
    ],
    [
      "JSON lookalike",
      {
        origin: "BASE",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json-evil",
      },
      "form",
    ],
  ])("rejects %s without cookie mutations", async (_label, headers, kind) => {
    const form = new FormData();
    form.append("input", "{}");
    const resolved = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        value === "BASE" ? base : value,
      ])
    );
    const res = await rawLogout(
      resolved,
      kind === "multipart" ? form : "input=%7B%7D"
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ["missing Origin", { "sec-fetch-site": "same-origin" }],
    ["cross-origin", { origin: "https://attacker.invalid" }],
    ["null Origin", { origin: "null" }],
    [
      "noncanonical Origin",
      {
        origin: "https://app.example.invalid/path",
        "sec-fetch-site": "same-origin",
      },
    ],
    [
      "cross-site Fetch Metadata",
      { origin: "BASE", "sec-fetch-site": "cross-site" },
    ],
    [
      "same-site Fetch Metadata",
      { origin: "BASE", "sec-fetch-site": "same-site" },
    ],
    ["none Fetch Metadata", { origin: "BASE", "sec-fetch-site": "none" }],
    [
      "cross-site Fetch Metadata without Origin",
      { "sec-fetch-site": "cross-site" },
    ],
  ])(
    "rejects JSON with %s and leaves cookies untouched",
    async (_label, headers) => {
      const resolved = Object.fromEntries(
        Object.entries(headers)
          .filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
          .map(([key, value]) => [key, value === "BASE" ? base : value])
      );
      const res = await rawLogout(
        { "content-type": "application/json", ...resolved },
        jsonInput
      );
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  );

  it("accepts a matching Origin when Fetch Metadata is unavailable", async () => {
    const res = await rawLogout(
      { origin: base, "content-type": "application/json; charset=utf-8" },
      jsonInput
    );
    expect(res.status).toBe(200);
    expectCleared(res, TX_COOKIE, "None");
  });

  it("supports Preview when same-origin Fetch Metadata accompanies a rewritten Host", async () => {
    const res = await rawLogout(
      {
        origin: "https://preview.example.invalid",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      jsonInput
    );
    expect(res.status).toBe(200);
    expectCleared(res, TX_COOKIE, "None");
  });

  it("expires the transaction even when a Preview request omits the Lax cookie", async () => {
    const res = await fetch(`${base}/api/trpc/auth.logout`, {
      method: "POST",
      headers: {
        origin: appOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: `${COOKIE_NAME}=test`,
      },
      body: jsonInput,
    });
    expect(res.status).toBe(200);
    expectCleared(res, TX_COOKIE, "None");
  });

  it("participant logout expires the transaction but leaves staff sessions alone", async () => {
    const res = await fetch(`${base}/api/auth/participant/logout`, {
      method: "POST",
      headers: {
        origin: appOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: allCookies,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expectCleared(res, PARTICIPANT_COOKIE, "None");
    expectCleared(res, TX_COOKIE, "None");
    expect(res.headers.getSetCookie()).toHaveLength(2);
  });

  it("clears a real pending Google transaction on logout before a later callback", async () => {
    const transaction = await beginGoogleTransaction();
    const res = await fetch(`${base}/api/trpc/auth.logout`, {
      method: "POST",
      headers: {
        origin: appOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: transaction.transaction,
      },
      body: jsonInput,
    });
    expect(res.status).toBe(200);
    expectCleared(res, TX_COOKIE, "None");
    await expectLaterCallbackRejected(transaction.state);
  });

  it("clears a real pending Google transaction when switching to participant", async () => {
    const transaction = await beginGoogleTransaction();
    const res = await fetch(`${base}/api/auth/participant/start`, {
      method: "POST",
      headers: {
        origin: appOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: transaction.transaction,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(cookieHeader(res, PARTICIPANT_COOKIE)).toContain("SameSite=None");
    expectCleared(res, TX_COOKIE, "None");
    expectCleared(res, GOOGLE_COOKIE, "None");
    expectCleared(res, COOKIE_NAME, "None");
    await expectLaterCallbackRejected(transaction.state);
  });

  it("Google logout emits the Preview-safe Manus deletion and clears the transaction", async () => {
    const res = await fetch(`${base}/api/auth/google/logout`, {
      method: "POST",
      headers: {
        origin: appOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: allCookies,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expectCleared(res, COOKIE_NAME, "None");
    expectCleared(res, GOOGLE_COOKIE, "None");
    expectCleared(res, TX_COOKIE, "None");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
