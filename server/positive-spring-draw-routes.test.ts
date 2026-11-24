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
import type { AuthenticatedUser } from "./_core/sdk";
import {
  POSITIVE_SPRING_DRAW_AT,
  POSITIVE_SPRING_EVENT_ID,
  POSITIVE_SPRING_RED_PACKET_KEY,
  POSITIVE_SPRING_RESERVED_PRIZE_ID,
} from "../shared/eventflow";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  aggregate: null as any,
}));

vi.mock("./_core/sdk", () => ({
  sdk: { authenticateRequest: mocks.authenticate },
}));
vi.mock("./eventflow/system-access", () => ({
  systemRoleFor: vi.fn(async () => "user"),
}));
vi.mock("./eventflow/database", () => ({
  lockedEventRow: async () => ({
    id: POSITIVE_SPRING_EVENT_ID,
    owner_user_id: 99,
    event_state: JSON.stringify(mocks.aggregate),
  }),
  readRows: async () => [],
  withTransaction: async (fn: Function) =>
    fn({ query: mocks.query, execute: mocks.execute }),
}));

import { registerEventFlowRoutes } from "./eventflow/routes";

function makeAggregate() {
  return {
    version: 1,
    event: {
      id: POSITIVE_SPRING_EVENT_ID,
      tenantId: "tenant",
      name: "已改名的活動",
      slug: "renamed",
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
      thresholdCents: 100000,
      accumulation: "per_transaction",
      ruleVersion: 1,
      excludeWinners: true,
    },
    guests: [
      {
        id: "checked",
        tenantId: "tenant",
        eventId: POSITIVE_SPRING_EVENT_ID,
        name: "已簽到",
        email: "",
        phone: "",
        group: "",
        note: "",
        ticket: "000001",
        checkedInAt: "2027-01-31T08:30:00.000Z",
        tableId: null,
        seat: null,
        chances: 0,
        createdAt: "2027-01-01T00:00:00.000Z",
      },
      {
        id: "absent",
        tenantId: "tenant",
        eventId: POSITIVE_SPRING_EVENT_ID,
        name: "未簽到",
        email: "",
        phone: "",
        group: "",
        note: "",
        ticket: "000002",
        checkedInAt: null,
        tableId: null,
        seat: null,
        chances: 999,
        createdAt: "2027-01-01T00:00:00.000Z",
      },
    ],
    tables: [],
    merchants: [],
    receipts: [],
    payments: [],
    prizes: [
      {
        id: POSITIVE_SPRING_RESERVED_PRIZE_ID,
        name: "HK$1,000 利是",
        key: POSITIVE_SPRING_RED_PACKET_KEY,
        drawId: null,
      },
    ],
    draws: [],
    ledger: [],
    audit: [],
  };
}

let base: string;
let server: Server;

beforeAll(async () => {
  process.env.MANUS_JWT_SECRET = "route-test-secret";
  const app = express();
  app.use(express.json());
  registerEventFlowRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.on("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/eventflow`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  mocks.aggregate = makeAggregate();
  mocks.authenticate.mockResolvedValue({
    id: 99,
    email: "owner@example.test",
    authProvider: "google",
    emailVerified: true,
  } as AuthenticatedUser);
  mocks.query.mockImplementation(async (sql: string) =>
    sql.includes("ef_idempotency") ? [[]] : [[]]
  );
  mocks.execute.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes("UPDATE ef_events"))
      mocks.aggregate = JSON.parse(String(args[0]));
    return [[]];
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(POSITIVE_SPRING_DRAW_AT));
});

afterEach(() => vi.useRealTimers());

async function draw(key: string) {
  return fetch(
    `${base}/events/${POSITIVE_SPRING_EVENT_ID}/draws/positive-spring-red-packet`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: "{}",
    }
  );
}

describe("positive spring red-packet draw route", () => {
  it("rejects before the Hong Kong start instant without changing state", async () => {
    vi.setSystemTime(new Date("2027-01-31T08:59:59.999Z"));
    const response = await draw("before-start-key");
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("DRAW_NOT_STARTED");
    expect(mocks.aggregate.prizes).toHaveLength(1);
    expect(mocks.aggregate.draws).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("draws once from checked-in guests only and rejects a new-key retry", async () => {
    const response = await draw("first-draw-key");
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.prizeName).toBe("HK$1,000 利是");
    expect(result.totalChances).toBe(1);
    expect(result.eligibleGuests).toBe(1);
    expect(mocks.aggregate.prizes[0]).toMatchObject({
      key: POSITIVE_SPRING_RED_PACKET_KEY,
      drawId: result.id,
    });
    expect(mocks.aggregate.draws).toHaveLength(1);
    const retry = await draw("second-draw-key");
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe("SPECIAL_DRAW_ALREADY_DONE");
    expect(mocks.aggregate.draws).toHaveLength(1);
  });

  it("creates the reserved prize for an empty draft and rejects a second draw", async () => {
    mocks.aggregate.prizes = [];
    const response = await draw("empty-prizes-first-draw");
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(mocks.aggregate.prizes[0]).toMatchObject({
      id: POSITIVE_SPRING_RESERVED_PRIZE_ID,
      key: POSITIVE_SPRING_RED_PACKET_KEY,
      name: "HK$1,000 利是",
      drawId: result.id,
    });
    const retry = await draw("empty-prizes-second-draw");
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe("SPECIAL_DRAW_ALREADY_DONE");
  });

  it.each([
    [
      "closed event",
      (aggregate: ReturnType<typeof makeAggregate>) => {
        aggregate.event.status = "closed";
      },
      "SPECIAL_DRAW_EVENT_CLOSED",
    ],
    [
      "wrong event date",
      (aggregate: ReturnType<typeof makeAggregate>) => {
        aggregate.event.date = "2027-02-01";
      },
      "SPECIAL_DRAW_EVENT_DATE_MISMATCH",
    ],
    [
      "missing prize with historical special draw",
      (aggregate: ReturnType<typeof makeAggregate>) => {
        aggregate.prizes = [];
        (aggregate.draws as any[]).push({
          id: "old-special",
          prizeId: POSITIVE_SPRING_RESERVED_PRIZE_ID,
          specialKey: POSITIVE_SPRING_RED_PACKET_KEY,
          prizeName: "HK$1,000 利是",
          winner: {
            id: "checked",
            name: "已簽到",
            ticket: "000001",
            tableNumber: null,
          },
          winnerGuestId: "checked",
          totalChances: 1,
          eligibleGuests: 1,
          createdAt: "2027-01-31T09:00:00.000Z",
          revealedAt: "2027-01-31T09:01:00.000Z",
          snapshot: [],
        });
      },
      "SPECIAL_DRAW_PRIZE_INVALID",
    ],
    [
      "lost prize-to-draw association",
      (aggregate: ReturnType<typeof makeAggregate>) => {
        (aggregate.draws as any[]).push({
          id: "orphan-draw",
          prizeId: "positive-prize",
          prizeName: "HK$1,000 利是",
          winner: {
            id: "checked",
            name: "已簽到",
            ticket: "000001",
            tableNumber: null,
          },
          winnerGuestId: "checked",
          totalChances: 1,
          eligibleGuests: 1,
          createdAt: "2027-01-31T09:00:00.000Z",
          revealedAt: null,
          snapshot: [],
        });
      },
      "SPECIAL_DRAW_PRIZE_INVALID",
    ],
  ])("fails closed for %s", async (_label, mutate, code) => {
    mutate(mocks.aggregate);
    const response = await draw(`guard-${_label}`);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(code);
    expect(mocks.aggregate.draws).toHaveLength(
      _label === "lost prize-to-draw association" ||
        _label === "missing prize with historical special draw"
        ? 1
        : 0
    );
  });
});
