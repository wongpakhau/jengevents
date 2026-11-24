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
import express from "express";
import type { Server } from "node:http";
import type { EventAggregate } from "./eventflow/engine";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  aggregate: null as any,
  invites: new Map<string, any>(),
  idempotency: new Map<string, any>(),
  role: "merchant",
  merchantId: "merchant",
  queue: Promise.resolve(),
}));
vi.mock("./_core/sdk", () => ({
  sdk: { authenticateRequest: mocks.authenticate },
}));
vi.mock("./eventflow/system-access", () => ({
  systemRoleFor: vi.fn(async () => "user"),
}));
vi.mock("./eventflow/database", () => ({
  lockedEventRow: async (connection: any, id: string) => ({
    id,
    tenant_id: "tenant",
    owner_user_id: 99,
    event_state: JSON.stringify(mocks.aggregate),
  }),
  readRows: async (sql: string, args: any[]) => {
    if (sql.includes("ef_invites")) {
      const invite = mocks.invites.get(args[0]);
      return invite ? [invite] : [];
    }
    if (sql.includes("ef_events"))
      return [
        {
          id: mocks.aggregate.event.id,
          tenant_id: "tenant",
          owner_user_id: 99,
          event_state: JSON.stringify(mocks.aggregate),
        },
      ];
    return [];
  },
  withTransaction: async (fn: Function) => {
    const previous = mocks.queue;
    let release!: () => void;
    mocks.queue = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    const state = JSON.stringify(mocks.aggregate);
    const invites = structuredClone(mocks.invites),
      idempotency = structuredClone(mocks.idempotency);
    try {
      return await fn({ query: mocks.query, execute: mocks.execute });
    } catch (error) {
      mocks.aggregate = JSON.parse(state);
      mocks.invites = invites;
      mocks.idempotency = idempotency;
      throw error;
    } finally {
      release();
    }
  },
}));

import { registerEventFlowRoutes } from "./eventflow/routes";
import {
  issuePurchaseCode,
  PURCHASE_CODE_TTL_MS,
} from "./eventflow/purchase-code";
import { merchantSettlement } from "./eventflow/accounting";
import { sha256 } from "./eventflow/security";

const time = new Date("2027-01-01T00:00:00.000Z");
const guestToken = "guest-login-capability",
  otherToken = "other-guest-capability";
function makeAggregate(): EventAggregate {
  const guest = (id: string, name: string) => ({
    id,
    tenantId: "tenant",
    eventId: "event",
    name,
    email: "private@example.test",
    phone: "private-phone",
    group: "private-group",
    note: "private-note",
    ticket: id === "guest" ? "000001" : "000002",
    checkedInAt: null,
    tableId: null,
    seat: null,
    chances: 0,
    createdAt: time.toISOString(),
  });
  return {
    version: 1,
    event: {
      id: "event",
      tenantId: "tenant",
      name: "Test",
      slug: "test",
      date: "2027-01-31",
      venue: "",
      status: "live",
      mode: "full",
      program: {
        titleEn: "",
        organizationEn: "",
        venueAddress: "",
        receptionTime: "",
        seatingTime: "",
      },
      brand: { name: "Test", color: "#C89538", logoUrl: "", privacyText: "" },
      registrationOpen: false,
      thresholdCents: 50000,
      accumulation: "cumulative",
      ruleVersion: 2,
      excludeWinners: true,
    },
    guests: [guest("guest", "嘉賓一"), guest("other", "嘉賓二")],
    merchants: [
      {
        id: "merchant",
        tenantId: "tenant",
        eventId: "event",
        name: "商戶一",
        active: true,
        createdAt: time.toISOString(),
      },
      {
        id: "merchant-other",
        tenantId: "tenant",
        eventId: "event",
        name: "商戶二",
        active: true,
        createdAt: time.toISOString(),
      },
    ],
    receipts: [],
    payments: [],
    tables: [],
    prizes: [],
    draws: [],
    audit: [],
    ledger: [],
  };
}
function addGuestInvite(token: string, guestId: string) {
  mocks.invites.set(sha256(token), {
    id: `invite-${guestId}`,
    token_hash: sha256(token),
    event_id: "event",
    kind: "guest",
    guest_id: guestId,
    expires_at: null,
    revoked_at: null,
    consumed_at: null,
  });
}
let base: string,
  server: Server,
  serial = 0;
beforeAll(async () => {
  process.env.MANUS_JWT_SECRET = "mocked-purchase-route-test-secret";
  const app = express();
  app.use(express.json());
  registerEventFlowRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.on("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/eventflow`;
});
afterAll(() => server.close());
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
  mocks.aggregate = makeAggregate();
  mocks.invites.clear();
  mocks.idempotency.clear();
  mocks.queue = Promise.resolve();
  mocks.role = "merchant";
  mocks.merchantId = "merchant";
  mocks.authenticate.mockReset();
  mocks.authenticate.mockResolvedValue({
    id: 99,
    authProvider: "google",
    emailVerified: true,
  });
  addGuestInvite(guestToken, "guest");
  addGuestInvite(otherToken, "other");
  mocks.query.mockReset();
  mocks.execute.mockReset();
  mocks.query.mockImplementation(async (sql: string, args: any[]) => {
    if (sql.includes("ef_idempotency")) {
      const row = mocks.idempotency.get(JSON.stringify(args));
      return [row ? [row] : []];
    }
    if (sql.includes("ef_invites")) {
      const row = mocks.invites.get(args[0]);
      return [row ? [row] : []];
    }
    if (sql.includes("ef_members"))
      return [[{ role: mocks.role, merchant_id: mocks.merchantId }]];
    return [[]];
  });
  mocks.execute.mockImplementation(async (sql: string, args: any[]) => {
    if (sql.includes("UPDATE ef_events")) mocks.aggregate = JSON.parse(args[0]);
    if (sql.includes("INSERT INTO ef_idempotency"))
      mocks.idempotency.set(JSON.stringify(args.slice(1, 5)), {
        request_hash: args[5],
        response_ciphertext: args[6],
      });
    if (sql.includes("INSERT INTO ef_invites"))
      mocks.invites.set(args[3], {
        id: args[0],
        event_id: args[1],
        kind: args[2],
        token_hash: args[3],
        guest_id: args[4],
        expires_at: args[9] ? args[9].replace(" ", "T") + "Z" : null,
        revoked_at: null,
        consumed_at: null,
      });
    if (sql.includes("UPDATE ef_invites SET guest_id"))
      mocks.invites.get(args[1]).guest_id = args[0];
    if (sql.includes("UPDATE ef_invites SET claimed_by_guest_id"))
      for (const invite of mocks.invites.values())
        if (invite.id === args[2]) {
          invite.claimed_by_guest_id = args[0];
          invite.consumed_at = args[1];
        }
    return [[]];
  });
});
afterEach(() => vi.useRealTimers());
async function request(
  path: string,
  body?: unknown,
  options: {
    key?: string | null;
    guest?: string;
    headers?: Record<string, string>;
  } = {}
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Guest-Token": options.guest ?? guestToken,
    ...options.headers,
  };
  if (options.key !== null)
    headers["Idempotency-Key"] = options.key ?? `purchase-test-key-${++serial}`;
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
function code() {
  return issuePurchaseCode(
    { eventId: "event", guestId: "guest", guestInviteHash: sha256(guestToken) },
    new Date()
  ).code;
}
async function issue(
  amountCents = 100000,
  extra: Record<string, unknown> = {},
  options = {}
) {
  return request(
    "/events/event/receipts",
    {
      merchantId: "merchant",
      amountCents,
      reference: `reference-${++serial}`,
      purchaseCode: code(),
      ...extra,
    },
    options
  );
}
async function decision(id: string, confirmed = true, options = {}) {
  return request(`/guest/receipts/${id}/decision`, { confirmed }, options);
}
async function legacy() {
  return issue(100000, { purchaseCode: undefined });
}

describe("production purchase handshake with mocked DB only", () => {
  it("issues an idempotent purpose-only QR with no new invite and requires a key", async () => {
    const issued = await request(
      "/guest/purchase-code",
      {},
      { key: "code-first-key" }
    );
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({
      code: expect.any(String),
      path: expect.stringContaining("/merchant#purchase="),
      expiresAt: "2027-01-01T00:10:00.000Z",
    });
    expect(
      (await request("/guest/purchase-code", {}, { key: "code-first-key" }))
        .body
    ).toEqual(issued.body);
    expect(mocks.invites.size).toBe(2);
    expect(
      mocks.execute.mock.calls.some(([sql]) => sql.includes("UPDATE ef_events"))
    ).toBe(false);
    expect(
      (await request("/guest/purchase-code", {}, { key: null })).body.code
    ).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
  it("resolves just id/name/ticket, read-only and without idempotency", async () => {
    const resolved = await request(
      "/events/event/purchase-code/resolve",
      { code: code(), merchantId: "merchant" },
      { key: null }
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.guest).toEqual({
      id: "guest",
      name: "嘉賓一",
      ticket: "000001",
      memberCode: "M000001",
    });
    expect(JSON.stringify(resolved.body)).not.toMatch(
      /private|phone|email|note|group/
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("issues pending receipts without claim tokens or sales; lists only intended guest's receipts", async () => {
    const issued = await issue();
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({
      possibleChances: 2,
      receipt: {
        status: "pending",
        intendedGuestId: "guest",
        confirmationRequired: true,
        merchantName: "商戶一",
        guestId: null,
        chances: 0,
      },
    });
    expect(issued.body).not.toHaveProperty("token");
    expect(issued.body).not.toHaveProperty("path");
    expect(mocks.invites.size).toBe(2);
    expect(
      merchantSettlement(
        mocks.aggregate.merchants[0],
        mocks.aggregate.receipts,
        []
      ).salesCents
    ).toBe(0);
    expect((await request("/guest")).body.receipts).toHaveLength(1);
    expect(
      (await request("/guest", undefined, { guest: otherToken })).body.receipts
    ).toHaveLength(0);
  });
  it("atomically confirms once, replays the same key, new-key retry gains zero; wrong/conflicting decisions fail", async () => {
    const id = (await issue()).body.receipt.id;
    expect((await decision(id, true, { guest: otherToken })).body.code).toBe(
      "RECEIPT_GUEST_SCOPE"
    );
    const first = await decision(id, true, { key: "confirm-same-key" });
    expect(first.body).toMatchObject({
      gained: 2,
      total: 2,
      alreadyClaimed: false,
      receipt: {
        status: "valid",
        guestId: "guest",
        decisionAt: time.toISOString(),
      },
    });
    expect(
      (await decision(id, true, { key: "confirm-same-key" })).body
    ).toEqual(first.body);
    expect((await decision(id)).body).toMatchObject({
      gained: 0,
      total: 2,
      alreadyClaimed: true,
    });
    expect((await decision(id, false)).body.code).toBe(
      "RECEIPT_DECISION_CONFLICT"
    );
    expect(mocks.aggregate.ledger).toHaveLength(1);
    expect(
      mocks.aggregate.audit.filter((a: any) => a.action === "receipt.confirmed")
    ).toHaveLength(1);
    expect(
      merchantSettlement(
        mocks.aggregate.merchants[0],
        mocks.aggregate.receipts,
        []
      ).salesCents
    ).toBe(100000);
  });
  it("serializes concurrent confirmations without duplicate awards", async () => {
    const id = (await issue()).body.receipt.id;
    const results = await Promise.all([decision(id), decision(id)]);
    expect(results.map(result => result.body.gained).sort()).toEqual([0, 2]);
    expect(mocks.aggregate.ledger).toHaveLength(1);
  });
  it("rejects without sales or chances and rejects later confirmation", async () => {
    const id = (await issue()).body.receipt.id;
    expect((await decision(id, false)).body).toMatchObject({
      gained: 0,
      total: 0,
      receipt: { status: "rejected", guestId: null, chances: 0 },
    });
    expect((await decision(id, false)).body.alreadyClaimed).toBe(true);
    expect((await decision(id)).body.code).toBe("RECEIPT_DECISION_CONFLICT");
    expect(mocks.aggregate.ledger).toHaveLength(0);
    expect(
      merchantSettlement(
        mocks.aggregate.merchants[0],
        mocks.aggregate.receipts,
        []
      ).salesCents
    ).toBe(0);
  });
  it("uses receipt snapshots for cumulative HK$300 + HK$200 and later setting changes", async () => {
    const a = (await issue(30000)).body.receipt.id,
      b = (await issue(20000)).body.receipt.id;
    mocks.aggregate.event.ruleVersion = 99;
    mocks.aggregate.event.thresholdCents = 100;
    expect((await decision(a)).body.gained).toBe(0);
    expect((await decision(b)).body).toMatchObject({ gained: 1, total: 1 });
  });
  it("retains legacy issuance and read-only preview before explicit claim", async () => {
    mocks.aggregate.event.accumulation = "per_transaction";
    mocks.aggregate.event.thresholdCents = 100000;
    const issued = await legacy();
    expect(issued.body).toMatchObject({
      token: expect.any(String),
      path: expect.stringContaining("/guest#claim="),
      receipt: {
        status: "pending",
        thresholdCents: 100000,
        ruleVersion: 2,
        accumulation: "per_transaction",
      },
    });
    expect(
      merchantSettlement(
        mocks.aggregate.merchants[0],
        mocks.aggregate.receipts,
        []
      )
    ).toMatchObject({ salesCents: 0, dueCents: 0 });
    mocks.execute.mockClear();
    const preview = await request(
      "/guest/claim-preview",
      { token: issued.body.token },
      { key: null }
    );
    expect(preview.body).toMatchObject({
      merchantName: "商戶一",
      receipt: { amountCents: 100000, guestId: null },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.aggregate.ledger).toHaveLength(0);
    mocks.aggregate.event.thresholdCents = 100;
    expect(
      (await request("/guest/claim", { token: issued.body.token })).body
    ).toMatchObject({ gained: 1, total: 1 });
    expect(
      merchantSettlement(
        mocks.aggregate.merchants[0],
        mocks.aggregate.receipts,
        []
      )
    ).toMatchObject({ salesCents: 100000, dueCents: 10000 });
    expect(
      (await request("/guest/claim", { token: issued.body.token })).body
    ).toMatchObject({ gained: 0, alreadyClaimed: true });
  });
  it("rejects duplicate references and different-body idempotency reuse", async () => {
    const purchaseCode = code();
    const body = {
      merchantId: "merchant",
      reference: "same-reference",
      amountCents: 100000,
      purchaseCode,
    };
    expect(
      (
        await request("/events/event/receipts", body, {
          key: "reference-first-key",
        })
      ).status
    ).toBe(201);
    expect((await request("/events/event/receipts", body)).body.code).toBe(
      "RECEIPT_REFERENCE_EXISTS"
    );
    expect(
      (
        await request(
          "/events/event/receipts",
          { ...body, amountCents: 50000 },
          { key: "reference-first-key" }
        )
      ).body.code
    ).toBe("IDEMPOTENCY_MISMATCH");
    expect(mocks.aggregate.receipts).toHaveLength(1);
  });
  it("does not let one decision key replay for a different receipt", async () => {
    const a = (await issue()).body.receipt.id,
      b = (await issue()).body.receipt.id;
    await decision(a, true, { key: "receipt-decision-key" });
    expect(
      (await decision(b, true, { key: "receipt-decision-key" })).body.code
    ).toBe("IDEMPOTENCY_MISMATCH");
    expect(mocks.aggregate.receipts[1].status).toBe("pending");
  });
  it("checks revocation on each merchant use including issuance replay and guest decision replay", async () => {
    const purchaseCode = code();
    const body = {
      merchantId: "merchant",
      reference: "revocation-reference",
      amountCents: 100000,
      purchaseCode,
    };
    const id = (
      await request("/events/event/receipts", body, {
        key: "revoked-issue-key",
      })
    ).body.receipt.id;
    await decision(id, true, { key: "revoked-confirm-key" });
    mocks.invites.get(sha256(guestToken)).revoked_at = time.toISOString();
    expect(
      (
        await request("/events/event/purchase-code/resolve", {
          merchantId: "merchant",
          code: purchaseCode,
        })
      ).body.code
    ).toBe("GUEST_UNAUTHORIZED");
    expect(
      (
        await request("/events/event/receipts", body, {
          key: "revoked-issue-key",
        })
      ).body.code
    ).toBe("GUEST_UNAUTHORIZED");
    expect(
      (await decision(id, true, { key: "revoked-confirm-key" })).body.code
    ).toBe("GUEST_UNAUTHORIZED");
    expect(mocks.aggregate.ledger).toHaveLength(1);
  });
  it.each(["guest_manager", "checkin", "draw"])(
    "forbids the %s role from merchant resolve and issue",
    async role => {
      mocks.authenticate.mockResolvedValue({ id: 7 });
      mocks.role = role;
      expect(
        (
          await request("/events/event/purchase-code/resolve", {
            merchantId: "merchant",
            code: code(),
          })
        ).body.code
      ).toBe("FORBIDDEN");
      expect((await issue()).body.code).toBe("FORBIDDEN");
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );
  it.each(["admin", "project_manager", "merchant"])(
    "allows the authorized %s role",
    async role => {
      mocks.authenticate.mockResolvedValue({ id: 7 });
      mocks.role = role;
      expect(
        (
          await request("/events/event/purchase-code/resolve", {
            merchantId: "merchant",
            code: code(),
          })
        ).status
      ).toBe(200);
      expect((await issue()).status).toBe(201);
    }
  );
  it("forbids other merchants, inactive merchants, unauthenticated staff, and cross-origin requests", async () => {
    mocks.authenticate.mockResolvedValue({ id: 7 });
    expect(
      (await issue(100000, { merchantId: "merchant-other" })).body.code
    ).toBe("MERCHANT_SCOPE");
    mocks.aggregate.merchants[0].active = false;
    expect(
      (
        await request("/events/event/purchase-code/resolve", {
          merchantId: "merchant",
          code: code(),
        })
      ).body.code
    ).toBe("MERCHANT_INACTIVE");
    mocks.authenticate.mockRejectedValue(new Error("no login"));
    expect((await issue()).body.code).toBe("UNAUTHORIZED");
    expect(
      (
        await request(
          "/guest/purchase-code",
          {},
          { headers: { origin: "https://evil.example" } }
        )
      ).body.code
    ).toBe("ORIGIN_FORBIDDEN");
  });
  it("rejects forged/expired/cross-event codes and invite-binding mismatch without writes", async () => {
    for (const invalid of [
      "guest-login-capability",
      "purchase-v1.bad.cipher.text",
    ])
      expect((await issue(100000, { purchaseCode: invalid })).body.code).toBe(
        "PURCHASE_CODE_INVALID"
      );
    const expired = code();
    vi.setSystemTime(new Date(time.getTime() + PURCHASE_CODE_TTL_MS));
    expect((await issue(100000, { purchaseCode: expired })).body.code).toBe(
      "PURCHASE_CODE_EXPIRED"
    );
    vi.setSystemTime(time);
    const cross = issuePurchaseCode(
      {
        eventId: "other-event",
        guestId: "guest",
        guestInviteHash: sha256(guestToken),
      },
      time
    ).code;
    expect((await issue(100000, { purchaseCode: cross })).body.code).toBe(
      "CROSS_EVENT"
    );
    const mismatch = code();
    mocks.invites.get(sha256(guestToken)).guest_id = "other";
    expect((await issue(100000, { purchaseCode: mismatch })).body.code).toBe(
      "PURCHASE_CODE_SCOPE"
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("purchase codes cannot log in, check in, or be legacy receipt tokens", async () => {
    const purchaseCode = code();
    expect(
      (await request("/guest", undefined, { guest: purchaseCode })).body.code
    ).toBe("GUEST_UNAUTHORIZED");
    expect(
      (await request("/events/event/checkin", { token: purchaseCode })).status
    ).not.toBe(200);
    expect(
      (await request("/guest/claim-preview", { token: purchaseCode })).status
    ).not.toBe(200);
    expect(mocks.aggregate.guests[0].checkedInAt).toBeNull();
  });
  it("cannot bypass guest confirmation via legacy claim or preview even with a forged DB binding", async () => {
    const id = (await issue()).body.receipt.id;
    mocks.invites.set(sha256("fake-receipt-token"), {
      id: "fake",
      token_hash: sha256("fake-receipt-token"),
      event_id: "event",
      kind: "receipt",
      guest_id: id,
      expires_at: null,
    });
    expect(
      (await request("/guest/claim-preview", { token: "fake-receipt-token" }))
        .body.code
    ).toBe("RECEIPT_CONFIRMATION_REQUIRED");
    expect(
      (await request("/guest/claim", { token: "fake-receipt-token" })).body.code
    ).toBe("RECEIPT_CONFIRMATION_REQUIRED");
    expect(mocks.aggregate.ledger).toHaveLength(0);
  });
  it("voids pending/rejected with no ledger adjustment and blocks stale confirmed replays after void", async () => {
    const pending = (await issue()).body.receipt.id;
    expect(
      (
        await request(`/events/event/receipts/${pending}/void`, {
          reason: "pending cancelled",
        })
      ).body.status
    ).toBe("void");
    expect((await decision(pending)).body.code).toBe("RECEIPT_VOID");
    const rejected = (await issue()).body.receipt.id;
    await decision(rejected, false);
    expect(
      (
        await request(`/events/event/receipts/${rejected}/void`, {
          reason: "rejected cancelled",
        })
      ).body.status
    ).toBe("void");
    expect(mocks.aggregate.ledger).toHaveLength(0);
    const confirmed = (await issue()).body.receipt.id;
    await decision(confirmed, true, { key: "before-void-confirm-key" });
    await request(`/events/event/receipts/${confirmed}/void`, {
      reason: "confirmed cancelled",
    });
    expect(
      (await decision(confirmed, true, { key: "before-void-confirm-key" })).body
        .code
    ).toBe("RECEIPT_VOID");
    expect(mocks.aggregate.guests[0].chances).toBe(0);
  });
  it("validates expired receipts, guest capability expiry, receipt event and boolean decisions", async () => {
    const id = (await issue()).body.receipt.id;
    expect(
      (await request(`/guest/receipts/${id}/decision`, { confirmed: "yes" }))
        .body.code
    ).toBe("VALIDATION_ERROR");
    mocks.aggregate.receipts[0].eventId = "other";
    expect((await decision(id)).body.code).toBe("CROSS_EVENT");
    mocks.aggregate.receipts[0].eventId = "event";
    mocks.aggregate.receipts[0].expiresAt = time.toISOString();
    expect((await decision(id)).body.code).toBe("RECEIPT_EXPIRED");
    mocks.invites.get(sha256(guestToken)).expires_at = time.toISOString();
    expect((await decision(id)).body.code).toBe("TOKEN_EXPIRED");
  });
  it("legacy preview checks revoked/expired/void/cross-event/other guest and writes nothing", async () => {
    const issued = await legacy(),
      token = issued.body.token;
    const invite = () => mocks.invites.get(sha256(token));
    mocks.execute.mockClear();
    invite().revoked_at = time.toISOString();
    expect((await request("/guest/claim-preview", { token })).body.code).toBe(
      "RECEIPT_TOKEN_NOT_FOUND"
    );
    invite().revoked_at = null;
    invite().expires_at = time.toISOString();
    expect((await request("/guest/claim-preview", { token })).body.code).toBe(
      "RECEIPT_EXPIRED"
    );
    invite().expires_at = null;
    invite().event_id = "other";
    expect((await request("/guest/claim-preview", { token })).body.code).toBe(
      "CROSS_EVENT"
    );
    invite().event_id = "event";
    mocks.aggregate.receipts[0].status = "void";
    expect((await request("/guest/claim-preview", { token })).body.code).toBe(
      "RECEIPT_VOID"
    );
    mocks.aggregate.receipts[0].status = "valid";
    mocks.aggregate.receipts[0].intendedGuestId = "other";
    expect((await request("/guest/claim-preview", { token })).body.code).toBe(
      "RECEIPT_CLAIMED_BY_OTHER"
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("commerce guard blocks all new operations in attendance mode", async () => {
    const id = (await issue()).body.receipt.id;
    mocks.aggregate.event.mode = "attendance";
    expect((await request("/guest/purchase-code", {})).body.code).toBe(
      "FEATURE_DISABLED"
    );
    expect(
      (
        await request("/events/event/purchase-code/resolve", {
          merchantId: "merchant",
          code: code(),
        })
      ).body.code
    ).toBe("FEATURE_DISABLED");
    expect((await issue()).body.code).toBe("FEATURE_DISABLED");
    expect((await decision(id)).body.code).toBe("FEATURE_DISABLED");
    expect(
      (await request("/guest/claim-preview", { token: "anything" })).body.code
    ).toBe("FEATURE_DISABLED");
  });
  it("accommodates more than the old hourly polling limit", async () => {
    for (let index = 0; index < 65; index++) {
      vi.setSystemTime(new Date(time.getTime() + index * 5000));
      expect((await request("/guest")).status).toBe(200);
    }
  });
});
