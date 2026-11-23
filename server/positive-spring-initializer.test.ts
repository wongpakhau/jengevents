import { describe, expect, it } from "vitest";
import type { Connection } from "mysql2/promise";
import {
  APP_TABLES,
  EVENT_ID,
  LOCK_NAME,
  MARKER_KEY,
  ORGANIZATION_ID,
  buildInitialAggregate,
  initializePositiveSpring,
} from "./eventflow/positive-spring-initializer";

type Store = {
  organization: { id: string; owner: number | null; name: string } | null;
  event: {
    id: string;
    tenant_id: string;
    owner: number | null;
    slug: string;
    event_state: string;
  } | null;
  marker: {
    marker_key: string;
    organization_id: string;
    event_id: string;
  } | null;
  otherRows: string[];
};

// This is a fake connection, not a database and never imports a connector or URL.
class FakeConnection {
  committed: Store = {
    organization: null,
    event: null,
    marker: null,
    otherRows: [],
  };
  working: Store | null = null;
  calls: { sql: string; values: unknown[] }[] = [];
  lockAvailable = true;
  failOn = "";
  ownerNullable = true;
  charsets = "utf8mb4";
  missingTable = "";
  extraTable = "";
  engine = "InnoDB";
  committedCount = 0;
  rollbackCount = 0;

  asConnection(): Connection {
    return this as unknown as Connection;
  }
  async beginTransaction() {
    this.working = structuredClone(this.committed);
  }
  async commit() {
    if (!this.working) throw new Error("no transaction");
    this.committed = this.working;
    this.working = null;
    this.committedCount++;
  }
  async rollback() {
    this.working = null;
    this.rollbackCount++;
  }
  async execute(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (this.failOn && sql.includes(this.failOn))
      throw new Error("injected SQL error");
    if (sql.includes("GET_LOCK"))
      return [[{ acquired: this.lockAvailable ? 1 : 0 }], []];
    if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }], []];
    if (sql.startsWith("SET ")) return [[], []];
    if (sql.includes("information_schema.TABLES")) {
      const tables = APP_TABLES.filter(t => t !== this.missingTable).map(t => ({
        table_name: t,
        table_type: "BASE TABLE",
        engine: this.engine,
      }));
      if (this.extraTable)
        tables.push({
          table_name: this.extraTable as (typeof APP_TABLES)[number],
          table_type: "BASE TABLE",
          engine: this.engine,
        });
      return [tables, []];
    }
    if (sql.includes("information_schema.COLUMNS"))
      return [
        [
          {
            table_name: "ef_organizations",
            column_name: "owner_user_id",
            is_nullable: this.ownerNullable ? "YES" : "NO",
            character_set_name: null,
          },
          {
            table_name: "ef_events",
            column_name: "owner_user_id",
            is_nullable: this.ownerNullable ? "YES" : "NO",
            character_set_name: null,
          },
          {
            table_name: "ef_organizations",
            column_name: "name",
            is_nullable: "NO",
            character_set_name: this.charsets,
          },
          {
            table_name: "ef_events",
            column_name: "event_state",
            is_nullable: "NO",
            character_set_name: this.charsets,
          },
        ],
        [],
      ];
    if (!this.working) throw new Error("SQL outside transaction");
    const s = this.working;
    if (sql.startsWith("SELECT organization_id,event_id"))
      return [[...(s.marker?.marker_key === values[0] ? [s.marker] : [])], []];
    if (sql.startsWith("SELECT id FROM ef_organizations"))
      return [
        [...(s.organization?.id === values[0] ? [s.organization] : [])],
        [],
      ];
    if (sql.startsWith("SELECT id,tenant_id,slug,event_state"))
      return [[...(s.event?.id === values[0] ? [s.event] : [])], []];
    if (sql.startsWith("SELECT 1 FROM `")) {
      const table = sql.match(/`([^`]+)`/)![1]!;
      const present =
        s.otherRows.includes(table) ||
        (table === "ef_organizations" && s.organization) ||
        (table === "ef_events" && s.event) ||
        (table === "ef_initialization_markers" && s.marker);
      return [present ? [{ 1: 1 }] : [], []];
    }
    if (sql.startsWith("INSERT INTO ef_organizations")) {
      s.organization = {
        id: values[0] as string,
        owner: values[1] as null,
        name: values[2] as string,
      };
      return [[], []];
    }
    if (sql.startsWith("INSERT INTO ef_events")) {
      s.event = {
        id: values[0] as string,
        tenant_id: values[1] as string,
        owner: values[2] as null,
        slug: values[3] as string,
        event_state: values[4] as string,
      };
      return [[], []];
    }
    if (sql.startsWith("INSERT INTO ef_initialization_markers")) {
      s.marker = {
        marker_key: values[0] as string,
        organization_id: values[1] as string,
        event_id: values[2] as string,
      };
      return [[], []];
    }
    throw new Error(`unexpected fake SQL: ${sql}`);
  }
}
const run = (fake: FakeConnection) =>
  initializePositiveSpring(
    fake.asConnection(),
    new Date("2026-11-21T00:00:00.000Z")
  );

describe("正向春茗 new database initializer (no database)", () => {
  it("creates a complete standard aggregate with a date only and full mode", () => {
    const aggregate = buildInitialAggregate();
    expect(aggregate).toEqual({
      version: 1,
      event: {
        id: EVENT_ID,
        tenantId: ORGANIZATION_ID,
        name: "正向春茗",
        slug: expect.stringMatching(/^event-[0-9a-f]{8}$/),
        date: "2027-01-31",
        venue: "",
        status: "draft",
        mode: "full",
        program: {
          titleEn: "",
          organizationEn: "",
          venueAddress: "",
          receptionTime: "",
          seatingTime: "",
        },
        brand: {
          name: "正向春茗",
          color: "#C89538",
          logoUrl: "",
          privacyText: "",
        },
        registrationOpen: false,
        registrationCheckIn: false,
        rosterClaimEnabled: false,
        rosterChapters: [],
        thresholdCents: 50_000,
        accumulation: "cumulative",
        ruleVersion: 1,
        excludeWinners: true,
      },
      guests: [],
      tables: [],
      merchants: [],
      receipts: [],
      payments: [],
      prizes: [],
      draws: [],
      ledger: [],
      audit: [],
    });
  });

  it("inserts exactly the organization, event and durable marker together with NULL owners", async () => {
    const fake = new FakeConnection();
    expect(await run(fake)).toBe("created");
    expect(fake.committedCount).toBe(1);
    expect(fake.rollbackCount).toBe(0);
    expect(fake.committed.organization).toEqual({
      id: ORGANIZATION_ID,
      owner: null,
      name: "正向春茗（籌備中）",
    });
    const event = fake.committed.event!;
    expect(event.owner).toBeNull();
    expect(JSON.parse(event.event_state)).toEqual({
      ...buildInitialAggregate(),
      event: { ...buildInitialAggregate().event, slug: event.slug },
    });
    expect(fake.committed.marker).toEqual({
      marker_key: MARKER_KEY,
      organization_id: ORGANIZATION_ID,
      event_id: EVENT_ID,
    });
    const writes = fake.calls.filter(c => c.sql.startsWith("INSERT"));
    expect(writes).toHaveLength(3);
    for (const write of writes)
      expect(write.sql).toMatch(/VALUES \(\?(,\?)+\)/);
    expect(writes[0]!.values[1]).toBeNull();
    expect(writes[1]!.values[2]).toBeNull();
    expect(
      fake.calls.some(
        c => c.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"
      )
    ).toBe(true);
    expect(fake.calls.find(c => c.sql.includes("GET_LOCK"))?.values).toEqual([
      LOCK_NAME,
      10,
    ]);
    expect(
      fake.calls.find(c => c.sql.includes("RELEASE_LOCK"))?.values
    ).toEqual([LOCK_NAME]);
  });

  it("retries as a read-only no-op despite later owner, name, state and other data changes", async () => {
    const fake = new FakeConnection();
    await run(fake);
    fake.committed.organization!.owner = 123;
    fake.committed.organization!.name = "使用者修改的組織名稱";
    fake.committed.event!.owner = 123;
    const changed = JSON.parse(fake.committed.event!.event_state);
    changed.event.name = "使用者修改的活動";
    changed.event.date = "2027-01-31T10:30:00+08:00";
    changed.event.status = "live";
    changed.guests.push({ id: "preserve-me" });
    fake.committed.event!.event_state = JSON.stringify(changed);
    fake.committed.otherRows.push("users", "ef_members");
    fake.extraTable = "ef_new_feature";
    const before = structuredClone(fake.committed);
    const start = fake.calls.length;
    expect(await run(fake)).toBe("already_initialized");
    expect(fake.committed).toEqual(before);
    expect(
      fake.calls
        .slice(start)
        .some(c => /^(INSERT|UPDATE|DELETE|REPLACE)/.test(c.sql))
    ).toBe(false);
  });

  it.each(APP_TABLES)(
    "refuses nonempty table %s without an authentic marker",
    async table => {
      const fake = new FakeConnection();
      fake.committed.otherRows.push(table);
      await expect(run(fake)).rejects.toThrow("空庫");
      expect(fake.rollbackCount).toBe(1);
      expect(fake.calls.some(c => c.sql.startsWith("INSERT"))).toBe(false);
    }
  );

  it.each([
    "missing organization",
    "missing event",
    "foreign tenant",
    "bad state",
    "incomplete aggregate",
    "wrong slug",
    "bad marker",
  ])("fails closed on %s", async problem => {
    const fake = new FakeConnection();
    await run(fake);
    switch (problem) {
      case "missing organization":
        fake.committed.organization = null;
        break;
      case "missing event":
        fake.committed.event = null;
        break;
      case "foreign tenant":
        fake.committed.event!.tenant_id = "other";
        break;
      case "bad state":
        fake.committed.event!.event_state = "not json";
        break;
      case "incomplete aggregate": {
        const value = JSON.parse(fake.committed.event!.event_state);
        delete value.guests;
        fake.committed.event!.event_state = JSON.stringify(value);
        break;
      }
      case "wrong slug":
        fake.committed.event!.slug = "other";
        break;
      case "bad marker":
        fake.committed.marker!.event_id = "other";
        break;
    }
    const before = structuredClone(fake.committed);
    await expect(run(fake)).rejects.toThrow();
    expect(fake.committed).toEqual(before);
    expect(fake.rollbackCount).toBe(1);
  });

  it.each(["INSERT INTO ef_events", "INSERT INTO ef_initialization_markers"])(
    "rolls back previous inserts if %s fails",
    async failOn => {
      const fake = new FakeConnection();
      fake.failOn = failOn;
      await expect(run(fake)).rejects.toThrow("injected SQL error");
      expect(fake.committed).toEqual({
        organization: null,
        event: null,
        marker: null,
        otherRows: [],
      });
      expect(fake.rollbackCount).toBe(1);
      expect(fake.calls.some(c => c.sql.includes("RELEASE_LOCK"))).toBe(true);
    }
  );

  it("refuses a competing initializer before beginning a transaction", async () => {
    const fake = new FakeConnection();
    fake.lockAvailable = false;
    await expect(run(fake)).rejects.toThrow("初始化鎖");
    expect(fake.working).toBeNull();
    expect(fake.calls.some(c => c.sql.startsWith("INSERT"))).toBe(false);
  });

  it.each(["nullable", "charset", "missing", "engine", "unknown table"])(
    "fails before inserts for invalid %s",
    async problem => {
      const fake = new FakeConnection();
      if (problem === "nullable") fake.ownerNullable = false;
      if (problem === "charset") fake.charsets = "latin1";
      if (problem === "missing") fake.missingTable = "ef_events";
      if (problem === "engine") fake.engine = "MyISAM";
      if (problem === "unknown table") fake.extraTable = "ef_unrecognized";
      await expect(run(fake)).rejects.toThrow();
      expect(fake.calls.some(c => c.sql.startsWith("INSERT"))).toBe(false);
      expect(fake.rollbackCount).toBe(1);
    }
  );
});
