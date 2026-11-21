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

// This test replaces the complete DB module. No pool, URL or network DB is used.
const mock = vi.hoisted(() => ({
  user: null as any,
  data: null as any,
  failAudit: false,
  failEventUpdate: false,
  queries: [] as string[],
  writes: [] as string[],
  queue: Promise.resolve(),
}));
vi.mock("./_core/sdk", () => ({
  sdk: {
    authenticateRequest: async () => {
      if (!mock.user) throw new Error("not authenticated");
      return mock.user;
    },
  },
}));
vi.mock("./_core/participantAuth", () => ({
  readParticipantSession: async () => null,
}));
vi.mock("./eventflow/database", () => {
  const bound = (d: any) =>
    d.org.owner_user_id != null && d.event.owner_user_id != null;
  async function query(
    sql: string,
    args: any[] = [],
    state = mock.data
  ): Promise<any[]> {
    mock.queries.push(sql);
    const d = state;
    if (sql.includes("ef_initialization_markers m JOIN"))
      return [
        [
          d.marker &&
          d.org.owner_user_id === null &&
          d.event.owner_user_id === null
            ? { id: d.event.id }
            : undefined,
        ].filter(Boolean),
      ];
    if (sql.includes("FROM ef_initialization_markers"))
      return [[...(d.marker ? [d.marker] : [])]];
    if (sql.includes("FROM ef_access_audit"))
      return [
        [
          ...d.audits.filter(
            (a: any) =>
              a.action === args[0] &&
              a.actor === args[1] &&
              a.target === args[2]
          ),
        ],
      ];
    if (sql.includes("FROM ef_system_admins"))
      return [[...(mock.user?.systemAdmin ? [{ user_id: mock.user.id }] : [])]];
    if (sql.includes("FROM users u")) return [[]];
    if (sql.includes("FROM ef_members m JOIN"))
      return [[...(bound(d) ? d.members : [])]];
    if (sql.includes("FROM ef_members"))
      return [
        [
          ...(sql.includes("FOR UPDATE")
            ? d.members
            : d.members.filter((m: any) => m.active)),
        ],
      ];
    if (sql.includes("FROM ef_invites"))
      return [
        [
          ...(sql.includes("token_hash")
            ? d.invite
              ? [d.invite]
              : []
            : d.invites),
        ],
      ];
    if (sql.includes("FROM ef_idempotency")) return [[...d.idempotency]];
    if (sql.includes("FROM ef_events")) {
      if (sql.includes("id <> ?")) return [[...d.extraEvents]];
      if (sql.includes("owner_user_id IS NOT NULL") && !bound(d)) return [[]];
      if (sql.includes("WHERE slug = ?") && args[0] !== d.event.slug)
        return [[]];
      if (sql.includes("WHERE id = ?") && args[0] !== d.event.id) return [[]];
      return [[d.event]];
    }
    if (sql.includes("FROM ef_organizations")) {
      if (sql.includes("IS NOT NULL") && d.org.owner_user_id == null)
        return [[]];
      return [[d.org]];
    }
    return [[]];
  }
  async function execute(sql: string, args: any[], d: any) {
    mock.writes.push(sql);
    if (sql.startsWith("UPDATE ef_organizations SET owner_user_id")) {
      d.org.owner_user_id = args[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE ef_events SET owner_user_id")) {
      if (mock.failEventUpdate) return [{ affectedRows: 0 }];
      d.event.owner_user_id = args[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("INSERT INTO ef_access_audit")) {
      if (mock.failAudit) throw new Error("simulated audit failure");
      d.audits.push({ actor: args[1], target: args[2], action: args[3] });
    }
    return [{ affectedRows: 1 }];
  }
  return {
    getPool: () => ({ query }),
    readRows: async (sql: string, args: any[] = []) =>
      (await query(sql, args))[0],
    lockedEventRow: async (_c: any, id: string) => {
      const [rows] = await _c.query(
        "SELECT id,tenant_id,owner_user_id,event_state FROM ef_events WHERE id = ? AND owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ef_organizations o WHERE o.id = ef_events.tenant_id AND o.owner_user_id IS NOT NULL) FOR UPDATE",
        [id]
      );
      if (!rows.length)
        throw new (await import("./eventflow/engine")).DomainError(
          404,
          "EVENT_NOT_FOUND",
          "找不到活動"
        );
      return rows[0];
    },
    withTransaction: async (fn: any) => {
      let release!: () => void;
      const previous = mock.queue;
      mock.queue = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;
      const state = structuredClone(mock.data);
      try {
        const result = await fn({
          query: (sql: string, args: any[]) => query(sql, args, state),
          execute: (sql: string, args: any[]) => execute(sql, args, state),
        });
        mock.data = state;
        return result;
      } finally {
        release();
      }
    },
  };
});
import { registerEventFlowRoutes } from "./eventflow/routes";
import {
  buildInitialAggregate,
  EVENT_ID,
  ORGANIZATION_ID,
} from "./eventflow/positive-spring-initializer";

let server: Server, base: string;
const owner = (id = 1, email = "pakhauwong@gmail.com") => ({
  id,
  email,
  name: "owner",
  authProvider: "google",
  emailVerified: true,
});
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerEventFlowRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.on("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/eventflow`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
});
beforeEach(() => {
  const aggregate = buildInitialAggregate();
  mock.data = {
    marker: { organization_id: ORGANIZATION_ID, event_id: EVENT_ID },
    org: {
      id: ORGANIZATION_ID,
      name: "正向春茗（籌備中）",
      owner_user_id: null,
    },
    event: {
      id: EVENT_ID,
      tenant_id: ORGANIZATION_ID,
      owner_user_id: null,
      slug: aggregate.event.slug,
      event_state: JSON.stringify(aggregate),
    },
    members: [],
    invites: [],
    idempotency: [],
    audits: [],
    extraEvents: [],
    invite: {
      id: "invite",
      event_id: EVENT_ID,
      kind: "guest",
      guest_id: "guest",
      revoked_at: null,
      consumed_at: null,
      expires_at: null,
    },
  };
  mock.user = owner();
  mock.failAudit = false;
  mock.failEventUpdate = false;
  mock.queries = [];
  mock.writes = [];
  mock.queue = Promise.resolve();
});
function request(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {}
) {
  return fetch(base + path, {
    method,
    headers: {
      ...(method === "GET"
        ? {}
        : {
            "content-type": "application/json",
            origin: new URL(base).origin,
            "idempotency-key": "12345678-1234-4234-8234-123456789abc",
          }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("pending ownership isolation", () => {
  it.each([
    ["system owner", owner()],
    ["system admin", { ...owner(8, "admin@example.test"), systemAdmin: true }],
    ["ordinary member", owner(9, "member@example.test")],
  ])(
    "blocks %s from reading, modifying, copying or inviting on a pending event",
    async (_name, user) => {
      mock.user = user;
      mock.data.members = [
        {
          id: "member",
          event_id: EVENT_ID,
          user_id: user.id,
          role: "admin",
          active: 1,
        },
      ];
      expect((await request(`/events/${EVENT_ID}/state`)).status).toBe(404);
      for (const [path, body] of [
        [`/events/${EVENT_ID}/copy`, { name: "copy" }],
        [`/events/${EVENT_ID}/members`, { name: "staff", role: "admin" }],
        [`/events/${EVENT_ID}/members/assign`, { userId: 9, role: "admin" }],
        [`/events/${EVENT_ID}/guests`, { name: "guest" }],
      ] as const)
        expect((await request(path, "POST", body)).status).toBe(404);
      expect(
        (
          await request("/events", "POST", {
            tenantId: ORGANIZATION_ID,
            name: "new",
            date: "2027-01-31",
          })
        ).status
      ).toBe(404);
      expect(mock.writes).toEqual([]);
    }
  );
  it.each(["event", "organization"])(
    "does not expose public slug or guest capability when %s is unowned",
    async which => {
      if (which === "event") mock.data.org.owner_user_id = 1;
      else mock.data.event.owner_user_id = 1;
      const slug = mock.data.event.slug;
      expect((await request(`/public/events/${slug}`)).status).toBe(404);
      for (const path of [
        "quick-names",
        "quick-search",
        "roster-names",
        "roster-search",
        "roster-match",
        "register",
      ]) {
        expect(
          (
            await request(`/public/events/${slug}/${path}`, "POST", {
              consent: true,
            })
          ).status
        ).toBe(404);
      }
      expect(
        (
          await request("/guest", "GET", undefined, {
            "X-Guest-Token": "guest-token",
          })
        ).status
      ).toBe(404);
      expect(
        (
          await request(
            "/guest/claim",
            "POST",
            { token: "receipt-token" },
            { "X-Guest-Token": "guest-token" }
          )
        ).status
      ).toBe(404);
      mock.data.invite.kind = "staff";
      expect(
        (await request("/invites/accept", "POST", { token: "staff-token" }))
          .status
      ).toBe(404);
      expect(mock.writes).toEqual([]);
    }
  );
  it("system directory and session SQL filter both unowned events and organizations", async () => {
    mock.user = { ...owner(8, "admin@example.test"), systemAdmin: true };
    const session = await (await request("/session")).json();
    expect(session.events).toEqual([]);
    expect(session.organizations).toEqual([]);
    const directory = await (await request("/system/access")).json();
    expect(directory.events).toEqual([]);
    expect(
      mock.queries
        .filter(q => q.includes("FROM ef_events"))
        .every(q => q.includes("owner_user_id IS NOT NULL"))
    ).toBe(true);
  });
  it("only allows verified allowlisted Google owners to discover or claim, never caller-supplied identity", async () => {
    for (const u of [
      null,
      owner(3, "ordinary@example.test"),
      { ...owner(), authProvider: "manus" },
      { ...owner(), emailVerified: false },
      { ...owner(), isCron: true },
      { ...owner(8, "admin@example.test"), systemAdmin: true },
    ]) {
      mock.user = u;
      expect((await request("/system/pending-ownership")).status).not.toBe(200);
      expect(
        (await request("/system/pending-ownership/claim", "POST", {})).status
      ).not.toBe(200);
    }
    mock.user = owner();
    expect(await (await request("/system/pending-ownership")).json()).toEqual([
      { eventId: EVENT_ID, name: "正向春茗", date: "2027-01-31" },
    ]);
    expect(
      (
        await request("/system/pending-ownership/claim", "POST", {
          userId: 123,
        })
      ).status
    ).toBe(400);
    expect(
      (await request("/system/pending-ownership/claim", "POST", { eventId: "other" })).status
    ).toBe(400);
    expect(
      (await request("/system/pending-ownership/claim", "POST", {}, { origin: "" })).status
    ).toBe(403);
    expect(
      (
        await request(
          "/system/pending-ownership/claim",
          "POST",
          {},
          { origin: "https://evil.invalid" }
        )
      ).status
    ).toBe(403);
    expect(
      (await request("/system/pending-ownership/claim", "POST", {}, {
        origin: "https://evil.invalid",
        "x-forwarded-host": "evil.invalid",
        "x-forwarded-proto": "https",
        "sec-fetch-site": "cross-site",
      })).status
    ).toBe(403);
    expect(mock.data.org.owner_user_id).toBeNull();
    expect(mock.data.event.owner_user_id).toBeNull();
  });
  it.each([
    "pakhauwong@gmail.com",
    "mikilee1028@gmail.com",
    "yeeayeeahk@gmail.com",
    "garyyang020730@gmail.com",
  ])("allows verified system owner %s to claim the pending event", async email => {
    mock.user = owner(4, email);
    expect((await request("/system/pending-ownership")).status).toBe(200);
    expect(
      (await request("/system/pending-ownership/claim", "POST", {})).status
    ).toBe(200);
    expect(mock.data.org.owner_user_id).toBe(4);
    expect(mock.data.event.owner_user_id).toBe(4);
  });
  it("claims both rows for the session identity, audits once and safely repeats", async () => {
    expect(
      (await request("/system/pending-ownership/claim", "POST", {})).status
    ).toBe(200);
    expect(mock.data.org.owner_user_id).toBe(1);
    expect(mock.data.event.owner_user_id).toBe(1);
    expect(mock.data.audits).toHaveLength(1);
    expect(
      await (
        await request("/system/pending-ownership/claim", "POST", {})
      ).json()
    ).toMatchObject({ alreadyAssigned: true });
    expect(mock.data.audits).toHaveLength(1);
  });
  it.each([
    "marker",
    "tenant",
    "orgOwner",
    "eventOwner",
    "state",
    "member",
    "invite",
    "idem",
    "otherEvent",
    "eventUpdate",
    "audit",
  ])(
    "rolls back and preserves both owners on conflict or failure: %s",
    async scenario => {
      switch (scenario) {
        case "marker":
          mock.data.marker.event_id = "different";
          break;
        case "tenant":
          mock.data.event.tenant_id = "different";
          break;
        case "orgOwner":
          mock.data.org.owner_user_id = 7;
          break;
        case "eventOwner":
          mock.data.event.owner_user_id = 7;
          break;
        case "state":
          mock.data.event.event_state = mock.data.event.event_state.replace(
            "正向春茗",
            "Changed"
          );
          break;
        case "member":
          mock.data.members.push({ id: "old" });
          break;
        case "invite":
          mock.data.invites.push({ id: "old" });
          break;
        case "idem":
          mock.data.idempotency.push({ id: "old" });
          break;
        case "otherEvent":
          mock.data.extraEvents.push({ id: "other" });
          break;
        case "eventUpdate":
          mock.failEventUpdate = true;
          break;
        case "audit":
          mock.failAudit = true;
          break;
      }
      const before = structuredClone(mock.data);
      expect(
        (await request("/system/pending-ownership/claim", "POST", {})).status
      ).not.toBe(200);
      expect(mock.data).toEqual(before);
    }
  );
  it("competing owners have exactly one winner and cannot overwrite each other", async () => {
    // Capture authenticated users before either asynchronous transaction begins.
    const { claimPendingOwnership } = await import(
      "./eventflow/pending-ownership"
    );
    const results = await Promise.allSettled([
      claimPendingOwnership(owner() as any),
      claimPendingOwnership(owner(2, "mikilee1028@gmail.com") as any),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(mock.data.org.owner_user_id).toBe(mock.data.event.owner_user_id);
    expect(mock.data.audits).toHaveLength(1);
  });
});
