import {
  afterAll,
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
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  role: "user",
  directory: vi.fn(),
}));
vi.mock("./_core/sdk", () => ({
  sdk: { authenticateRequest: mocks.authenticate },
}));
vi.mock("./eventflow/system-access", () => ({
  systemRoleFor: vi.fn(async () => mocks.role),
  accessDirectory: mocks.directory,
}));
vi.mock("./eventflow/database", () => ({
  readRows: async (sql: string, args: unknown[]) =>
    (await mocks.query(sql, args))[0],
  getPool: () => ({ query: mocks.query }),
  lockedEventRow: async () => ({
    id: "event",
    owner_user_id: 99,
    event_state: JSON.stringify(aggregate),
  }),
  withTransaction: async (fn: Function) =>
    fn({ query: mocks.query, execute: mocks.execute }),
}));
import { registerEventFlowRoutes } from "./eventflow/routes";
const aggregate = {
  version: 1,
  event: {
    id: "event",
    tenantId: "tenant",
    name: "Event",
    mode: "full",
    brand: { name: "Test", logoUrl: "", color: "#000", privacyText: "" },
    registrationOpen: false,
  },
  guests: [
    {
      id: "guest",
      tenantId: "tenant",
      eventId: "event",
      name: "Test",
      email: "private@test.invalid",
      phone: "91234567",
      ticket: "000001",
      checkedInAt: null,
      chances: 0,
    },
  ],
  tables: [{ id: "table", number: 1 }],
  merchants: [
    { id: "my", name: "Mine" },
    { id: "other", name: "Other" },
  ],
  receipts: [
    { id: "mine", merchantId: "my" },
    { id: "theirs", merchantId: "other" },
  ],
  payments: [],
  prizes: [],
  draws: [],
  members: [],
  audit: [],
  ledger: [],
};
let base: string, server: Server;
let eventRole = "merchant";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerEventFlowRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.on("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/eventflow`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "user";
  eventRole = "merchant";
  mocks.authenticate.mockResolvedValue({
    id: 1,
    email: "person@gmail.com",
    authProvider: "google",
    emailVerified: true,
  } as AuthenticatedUser);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("ef_members"))
      return [
        [
          {
            id: "member",
            event_id: "event",
            user_id: 1,
            role: eventRole,
            merchant_id: "my",
            active: 1,
          },
        ],
      ];
    if (sql.includes("ef_events"))
      return [
        [
          {
            id: "event",
            tenant_id: "tenant",
            owner_user_id: 99,
            event_state: JSON.stringify(aggregate),
          },
        ],
      ];
    return [[]];
  });
});
async function request(path: string, body?: unknown) {
  return fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "unit-test-key",
          },
          body: JSON.stringify(body),
        }
  );
}
describe("event access API", () => {
  it("pending ordinary users cannot create organizations or inspect system directory", async () => {
    expect((await request("/organizations", { name: "Attempt" })).status).toBe(
      403
    );
    expect((await request("/system/access")).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("merchant state contains only own receipts, no guest contacts or other stalls", async () => {
    const r = await request("/events/event/state");
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.guests).toEqual([]);
    expect(data.merchants.map((m: any) => m.id)).toEqual(["my"]);
    expect(data.receipts.map((m: any) => m.id)).toEqual(["mine"]);
  });
  it("guest manager gets guests/tables but not transactions, draws or member permissions", async () => {
    eventRole = "guest_manager";
    const r = await request("/events/event/state");
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.guests).toHaveLength(1);
    expect(data.tables).toHaveLength(1);
    for (const k of [
      "receipts",
      "merchants",
      "prizes",
      "draws",
      "members",
      "payments",
    ])
      expect(data[k]).toEqual([]);
  });
  it.each(["project_manager", "guest_manager", "merchant", "checkin"])(
    "%s cannot assign or invite another account",
    async role => {
      eventRole = role;
      expect(
        (
          await request("/events/event/members/assign", {
            userId: 2,
            role: "admin",
          })
        ).status
      ).toBe(403);
      expect(
        (
          await request("/events/event/members", {
            name: "Other",
            role: "admin",
          })
        ).status
      ).toBe(403);
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );
  it("project manager cannot clone an event into administrative privileges", async () => {
    eventRole = "project_manager";
    expect(
      (await request("/events/event/copy", { name: "Clone" })).status
    ).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
