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
import {
  eventDateFields,
  eventDateUpdateFromFields,
} from "../client/src/lib/event-date";

// All persistence is in-memory; these tests never connect to a real database.
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  rows: {} as Record<string, any>,
}));
vi.mock("./_core/sdk", () => ({
  sdk: { authenticateRequest: mocks.authenticate },
}));
vi.mock("./eventflow/system-access", () => ({
  systemRoleFor: vi.fn(async () => "owner"),
  accessDirectory: vi.fn(),
}));
vi.mock("./eventflow/database", () => ({
  readRows: async (sql: string, args: unknown[]) =>
    (await mocks.query(sql, args))[0],
  withTransaction: async (fn: Function) =>
    fn({ query: mocks.query, execute: mocks.execute }),
  lockedEventRow: async (_connection: unknown, id: string) => mocks.rows[id],
  getPool: () => ({ query: mocks.query }),
}));
import { registerEventFlowRoutes } from "./eventflow/routes";

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerEventFlowRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.on("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/eventflow`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MANUS_JWT_SECRET", "unit-test-secret");
  mocks.rows = {};
  mocks.authenticate.mockResolvedValue({
    id: 1,
    name: "Test",
    email: "test@example.invalid",
    authProvider: "google",
    emailVerified: true,
  });
  mocks.query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes("ef_organizations") && !sql.includes("ef_events"))
      return [[{ id: "tenant", name: "Test", owner_user_id: 1 }]];
    if (sql.includes("ef_idempotency")) return [[]];
    if (sql.includes("ef_events")) {
      const row = sql.includes("WHERE slug")
        ? Object.values(mocks.rows).find(item => item.slug === args[0])
        : mocks.rows[String(args[0])];
      return [[...(row ? [row] : [])]];
    }
    return [[]];
  });
  mocks.execute.mockImplementation(async (sql: string, args: any[]) => {
    if (sql.startsWith("INSERT INTO ef_events")) {
      const [id, tenant_id, owner_user_id, slug, event_state] = args;
      mocks.rows[id] = { id, tenant_id, owner_user_id, slug, event_state };
    } else if (sql.startsWith("UPDATE ef_events")) {
      mocks.rows[args[2]].event_state = args[0];
    }
    return [{}];
  });
});
async function request(method: string, path: string, body?: unknown) {
  return fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method,
          headers: {
            "content-type": "application/json",
            "idempotency-key": "test-event-date-key",
          },
          body: JSON.stringify(body),
        }
  );
}
async function create(overrides: Record<string, unknown> = {}) {
  return request("POST", "/events", {
    tenantId: "tenant",
    name: "正向春茗",
    date: "2027-01-31",
    mode: "attendance",
    ...overrides,
  });
}

describe("event date and venue API", () => {
  it("creates a date-only event without a venue and preserves both in state, public response and copies", async () => {
    const response = await create();
    expect(response.status).toBe(201);
    const event = await response.json();
    expect(event).toMatchObject({ date: "2027-01-31", venue: "" });
    expect(JSON.parse(mocks.rows[event.id].event_state).event).toMatchObject({
      date: "2027-01-31",
      venue: "",
    });
    const state = await request("GET", `/events/${event.id}/state`);
    expect((await state.json()).event).toMatchObject({
      date: "2027-01-31",
      venue: "",
    });
    const publicResponse = await request("GET", `/public/events/${event.slug}`);
    expect(await publicResponse.json()).toMatchObject({
      date: "2027-01-31",
      venue: "",
    });
    const copy = await request("POST", `/events/${event.id}/copy`, {
      name: "副本",
    });
    expect(copy.status).toBe(201);
    expect(await copy.json()).toMatchObject({ date: "2027-01-31", venue: "" });
  });

  it("supports whitespace as unset, updating to a specific instant and venue, then clearing them", async () => {
    const event = await (await create({ venue: "   " })).json();
    expect(event.venue).toBe("");
    const update = await request("PATCH", `/events/${event.id}/settings`, {
      date: "2027-01-31T18:30:00+08:00",
      venue: "  主會場  ",
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      date: "2027-01-31T10:30:00.000Z",
      venue: "主會場",
    });
    const clear = await request("PATCH", `/events/${event.id}/settings`, {
      date: "2027-01-31",
      venue: "  ",
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ date: "2027-01-31", venue: "" });
  });

  it.each(["2027-01-31T18:30:00+08:00", "2027-01-31T10:30:00.000Z"])(
    "accepts and copies explicit instants: %s",
    async date => {
      const response = await create({ date });
      expect(response.status).toBe(201);
      const event = await response.json();
      expect(event.date).toBe("2027-01-31T10:30:00.000Z");
      const copy = await request("POST", `/events/${event.id}/copy`, {
        name: "副本",
      });
      expect(copy.status).toBe(201);
      expect((await copy.json()).date).toBe(event.date);
    }
  );

  it.each([
    "2027-02-30",
    "2027-02-29",
    "2027-1-31",
    "2027-01-31T25:00Z",
    "2027-01-31T18:30",
    "2027-01-31T18:30:00",
    "2027-01-31T18:30:00.123",
  ])("rejects invalid dates on create and update: %s", async date => {
    const invalidCreate = await create({ date, venue: "" });
    expect(invalidCreate.status).toBe(400);
    const event = await (await create({ venue: "" })).json();
    const invalidUpdate = await request(
      "PATCH",
      `/events/${event.id}/settings`,
      { date }
    );
    expect(invalidUpdate.status).toBe(400);
    expect(JSON.parse(mocks.rows[event.id].event_state).event.date).toBe(
      "2027-01-31"
    );
  });

  it("reads and leaves an unchanged legacy wall time alone, but requires a valid date before copying it", async () => {
    const event = await (await create()).json();
    const stored = JSON.parse(mocks.rows[event.id].event_state);
    stored.event.date = "2027-01-31T18:30:00";
    mocks.rows[event.id].event_state = JSON.stringify(stored);

    const state = await request("GET", `/events/${event.id}/state`);
    expect((await state.json()).event.date).toBe("2027-01-31T18:30:00");
    const publicResponse = await request("GET", `/public/events/${event.slug}`);
    expect((await publicResponse.json()).date).toBe("2027-01-31T18:30:00");
    const unrelatedUpdate = await request(
      "PATCH",
      `/events/${event.id}/settings`,
      { venue: "主會場" }
    );
    expect(unrelatedUpdate.status).toBe(200);
    expect((await unrelatedUpdate.json()).date).toBe("2027-01-31T18:30:00");
    const invalidCopy = await request("POST", `/events/${event.id}/copy`, {
      name: "副本",
    });
    expect(invalidCopy.status).toBe(400);
    expect(Object.keys(mocks.rows)).toHaveLength(1);

    const corrected = await request("PATCH", `/events/${event.id}/settings`, {
      date: "2027-01-31",
    });
    expect(corrected.status).toBe(200);
    const copy = await request("POST", `/events/${event.id}/copy`, {
      name: "副本",
    });
    expect(copy.status).toBe(201);
    expect((await copy.json()).date).toBe("2027-01-31");
  });

  it("writes an explicitly confirmed legacy form time as an instant before copying", async () => {
    const event = await (await create()).json();
    const stored = JSON.parse(mocks.rows[event.id].event_state);
    const legacy = "2027-01-31T18:30";
    stored.event.date = legacy;
    mocks.rows[event.id].event_state = JSON.stringify(stored);
    const update = eventDateUpdateFromFields(
      eventDateFields(legacy),
      legacy,
      true
    );
    expect(update?.date).toMatch(/Z$/);
    const response = await request(
      "PATCH",
      `/events/${event.id}/settings`,
      update
    );
    expect(response.status).toBe(200);
    expect((await response.json()).date).toBe(update?.date);
    const copy = await request("POST", `/events/${event.id}/copy`, {
      name: "副本",
    });
    expect(copy.status).toBe(201);
    expect((await copy.json()).date).toBe(update?.date);
  });

  it("continues enforcing venue type and maximum length for create and update", async () => {
    expect((await create({ venue: 42 })).status).toBe(400);
    expect((await create({ venue: null })).status).toBe(400);
    expect((await create({ venue: "x".repeat(301) })).status).toBe(400);
    const event = await (await create()).json();
    expect(
      (await request("PATCH", `/events/${event.id}/settings`, { venue: 42 }))
        .status
    ).toBe(400);
    expect(
      (await request("PATCH", `/events/${event.id}/settings`, { venue: null }))
        .status
    ).toBe(400);
    expect(
      (
        await request("PATCH", `/events/${event.id}/settings`, {
          venue: "x".repeat(301),
        })
      ).status
    ).toBe(400);
  });
});
