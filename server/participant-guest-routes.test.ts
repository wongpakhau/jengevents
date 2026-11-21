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
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  participant: vi.fn(),
}));
vi.mock("./_core/sdk", () => ({
  sdk: {
    authenticateRequest: vi.fn(() => {
      throw new Error("no staff login");
    }),
  },
}));
vi.mock("./_core/participantAuth", () => ({
  readParticipantSession: mocks.participant,
}));
vi.mock("./eventflow/database", () => ({
  readRows: async (sql: string, args: unknown[]) =>
    (await mocks.query(sql, args))[0],
  withTransaction: async (fn: Function) =>
    fn({ query: mocks.query, execute: mocks.execute }),
  lockedEventRow: vi.fn(),
  getPool: () => ({ query: mocks.query }),
}));
import { registerEventFlowRoutes } from "./eventflow/routes";
const aggregate = {
  version: 1,
  event: {
    id: "event",
    tenantId: "tenant",
    name: "Test event",
    status: "draft",
    mode: "attendance",
    registrationOpen: true,
    registrationCheckIn: false,
    brand: { name: "Test", color: "#c89538", logoUrl: "", privacyText: "" },
  },
  guests: [
    {
      id: "guest",
      tenantId: "tenant",
      eventId: "event",
      name: "Test",
      phone: "",
      email: "",
      chances: 0,
      tableId: null,
      seat: null,
      ticket: "000001",
    },
  ],
  tables: [],
  receipts: [],
  merchants: [],
  draws: [],
  ledger: [],
  audit: [],
};
let expires: string | null = null;
let base: string;
let server: Server;
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
  vi.stubEnv("MANUS_JWT_SECRET", "only-unit-test-secret");
  expires = null;
  mocks.participant.mockResolvedValue(null);
  mocks.execute.mockResolvedValue([{}]);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("ef_invites"))
      return [
        [
          {
            id: "invite",
            event_id: "event",
            kind: "guest",
            guest_id: "guest",
            revoked_at: null,
            consumed_at: null,
            expires_at: expires,
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
async function register() {
  return fetch(base + "/public/events/test/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "12345678-1234-4234-8234-123456789abc",
    },
    body: JSON.stringify({
      name: "Unit guest",
      classType: "BP",
      classNumber: "62",
      phone: "91234567",
      consent: true,
    }),
  });
}
describe("temporary participant guest capability lifetime", () => {
  it("rejects expired guest reads before returning personal information", async () => {
    expires = new Date(Date.now() - 1).toISOString();
    const r = await fetch(base + "/guest", {
      headers: { "X-Guest-Token": "unit-guest" },
    });
    expect(r.status).toBe(410);
    expect(await r.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(
      mocks.query.mock.calls.some(([sql]) => sql.includes("ef_events"))
    ).toBe(false);
  });
  it("keeps original non-expiring personal invitations valid", async () => {
    const r = await fetch(base + "/guest", {
      headers: { "X-Guest-Token": "unit-guest" },
    });
    expect(r.status).toBe(200);
    expect((await r.json()).guest.id).toBe("guest");
  });
  it("allows a still-valid temporary personal invitation", async () => {
    expires = new Date(Date.now() + 60_000).toISOString();
    expect(
      (
        await fetch(base + "/guest", {
          headers: { "X-Guest-Token": "unit-guest" },
        })
      ).status
    ).toBe(200);
  });
  it("refuses expired guest claims before accessing business state", async () => {
    expires = new Date(Date.now() - 1).toISOString();
    const r = await fetch(base + "/guest/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Guest-Token": "unit-guest",
        "idempotency-key": "claim-unit-key",
      },
      body: JSON.stringify({ token: "receipt-unit" }),
    });
    expect(r.status).toBe(410);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("binds the new invitation to the original participant deadline, without granting staff", async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    mocks.participant.mockResolvedValue({
      id: "anonymous",
      role: "participant",
      issuedAt: new Date().toISOString(),
      expiresAt,
    });
    const r = await register();
    expect(r.status).toBe(201);
    expect((await r.json()).invitation.expiresAt).toBe(expiresAt);
    const insert = mocks.execute.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO ef_invites")
    );
    expect(insert?.[1]?.[9]).toBe(expiresAt.slice(0, 23).replace("T", " "));
    expect(
      mocks.execute.mock.calls.some(([sql]) =>
        /INSERT INTO (users|ef_members)/.test(sql)
      )
    ).toBe(false);
  });
  it("preserves ordinary public registration invitation lifetime", async () => {
    const r = await register();
    expect(r.status).toBe(201);
    expect((await r.json()).invitation.expiresAt).toBeUndefined();
    const insert = mocks.execute.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO ef_invites")
    );
    expect(insert?.[1]?.[9]).toBeNull();
  });
});
