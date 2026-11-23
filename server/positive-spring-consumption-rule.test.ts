import { describe, expect, it, vi } from "vitest";
import type { Connection } from "mysql2/promise";
import type { EventAggregate } from "./eventflow/engine";
import {
  EVENT_ID,
  MARKER_KEY as INITIALIZATION_MARKER_KEY,
  ORGANIZATION_ID,
  buildInitialAggregate,
} from "./eventflow/positive-spring-initializer";
import {
  CONSUMPTION_RULE_ACTOR,
  CONSUMPTION_RULE_MARKER_KEY,
  ConsumptionRuleError,
  planPositiveSpringConsumptionRule,
  setPositiveSpringConsumptionRule,
  type ConsumptionRuleEventRow,
  type ConsumptionRuleMode,
} from "./eventflow/positive-spring-consumption-rule";
import {
  consumptionRuleConnectionOptions,
  parseConsumptionRuleMode,
  runPositiveSpringConsumptionRuleCli,
} from "../scripts/set-positive-spring-consumption-rule";

const NOW = new Date("2026-11-23T15:00:00.000Z");
const OLD_DATE = "2026-11-21T00:00:00.000Z";
const FAKE_URL =
  "mysql://fake_user:fake_password@not-a-real-host.test/eventflow";

function fixture(): EventAggregate {
  const aggregate = buildInitialAggregate();
  // This migration targets the historical persisted rule, not new-event defaults.
  aggregate.event.thresholdCents = 100_000;
  aggregate.event.accumulation = "per_transaction";
  aggregate.event.slug = "preserve-original-slug";
  aggregate.event.ruleVersion = 7;
  aggregate.guests.push({
    id: "guest-one",
    tenantId: ORGANIZATION_ID,
    eventId: EVENT_ID,
    name: "Private guest name",
    email: "private@example.test",
    phone: "+85200000000",
    group: "private group",
    note: "private note",
    ticket: "private-ticket",
    checkedInAt: OLD_DATE,
    tableId: "table-one",
    seat: 1,
    chances: 2,
    createdAt: OLD_DATE,
  });
  aggregate.tables.push({
    id: "table-one",
    tenantId: ORGANIZATION_ID,
    eventId: EVENT_ID,
    number: 1,
    label: "Table 1",
    capacity: 12,
    x: 20,
    y: 30,
  });
  aggregate.merchants.push({
    id: "merchant-one",
    tenantId: ORGANIZATION_ID,
    eventId: EVENT_ID,
    name: "Private merchant",
    active: true,
    createdAt: OLD_DATE,
  });
  for (const [index, status] of [
    "valid",
    "pending",
    "rejected",
    "void",
  ].entries()) {
    aggregate.receipts.push({
      id: `receipt-${index}`,
      tenantId: ORGANIZATION_ID,
      eventId: EVENT_ID,
      merchantId: "merchant-one",
      amountCents: 200_000,
      feeCents: 20_000,
      status: status as EventAggregate["receipts"][number]["status"],
      guestId: status === "valid" ? "guest-one" : null,
      intendedGuestId: "guest-one",
      confirmationRequired: true,
      claimedAt: status === "valid" ? OLD_DATE : null,
      createdAt: OLD_DATE,
      expiresAt: "2027-02-01T00:00:00.000Z",
      reference: "private-reference",
      ruleVersion: 1,
      thresholdCents: 100_000,
      accumulation: "per_transaction",
      chances: status === "valid" ? 2 : 0,
    });
  }
  aggregate.ledger.push({
    id: "ledger-one",
    guestId: "guest-one",
    receiptId: "receipt-0",
    ruleVersion: 1,
    delta: 2,
    kind: "claim",
    createdAt: OLD_DATE,
  });
  aggregate.draws.push({
    id: "draw-one",
    prizeId: "prize-one",
    prizeName: "Original prize",
    winner: {
      id: "guest-one",
      name: "Private guest name",
      ticket: "private-ticket",
      tableNumber: 1,
    },
    winnerGuestId: "guest-one",
    totalChances: 2,
    eligibleGuests: 1,
    snapshot: [
      {
        guestId: "guest-one",
        ticket: "private-ticket",
        chances: 2,
        ledgerIds: ["ledger-one"],
        receiptIds: ["receipt-0"],
      },
    ],
    createdAt: OLD_DATE,
    revealedAt: OLD_DATE,
  });
  aggregate.prizes.push({
    id: "prize-one",
    name: "Original prize",
    drawId: "draw-one",
  });
  aggregate.payments.push({
    id: "payment-one",
    merchantId: "merchant-one",
    amountCents: 10_000,
    reference: "private-payment",
    createdAt: OLD_DATE,
  });
  aggregate.audit.push({
    id: "audit-original",
    actor: "user:1",
    action: "settings.updated",
    createdAt: OLD_DATE,
    detail: "Original audit detail",
  });
  return aggregate;
}

function eventRow(aggregate = fixture()): ConsumptionRuleEventRow & {
  created_at: string;
  updated_at: string;
} {
  return {
    id: EVENT_ID,
    tenant_id: ORGANIZATION_ID,
    slug: aggregate.event.slug,
    owner_user_id: null,
    event_state: JSON.stringify(aggregate),
    created_at: "2026-11-21 00:00:00.000",
    updated_at: "2026-11-22 00:00:00.000",
  };
}

type Store = {
  event: ReturnType<typeof eventRow> | null;
  markers: Record<
    string,
    { organization_id: string; event_id: string; created_at?: string }
  >;
};

/** All reads and writes use an in-memory store; no connector is called. */
class FakeConnection {
  committed: Store = {
    event: eventRow(),
    markers: {
      [INITIALIZATION_MARKER_KEY]: {
        organization_id: ORGANIZATION_ID,
        event_id: EVENT_ID,
        created_at: "2026-11-21 00:00:00.000",
      },
    },
  };
  working: Store | null = null;
  calls: { sql: string; values: unknown[] }[] = [];
  beginCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  endCount = 0;
  failOn = "";
  failClose = false;
  failRollback = false;
  affectedRows = 1;

  asConnection(): Connection {
    return this as unknown as Connection;
  }
  async beginTransaction() {
    this.beginCount++;
    this.working = structuredClone(this.committed);
  }
  async commit() {
    if (!this.working) throw new Error("No mock transaction");
    if (this.failOn === "COMMIT")
      throw new Error(
        "driver SQL password=secret private-reference commit failed"
      );
    this.committed = this.working;
    this.working = null;
    this.commitCount++;
  }
  async rollback() {
    this.rollbackCount++;
    this.working = null;
    if (this.failRollback)
      throw new Error("driver SQL password=secret rollback error");
  }
  async end() {
    this.endCount++;
    this.working = null;
    if (this.failClose)
      throw new Error("driver SQL password=secret close error");
  }
  async execute(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (this.failOn && sql.includes(this.failOn)) {
      throw new Error("driver SQL password=secret private-reference failed");
    }
    const store = this.working ?? this.committed;
    // Original initializer occupies the unique event/organization marker slot.
    // Any access to that table is forbidden, even a read or attempted insert.
    if (sql.includes("ef_initialization_markers"))
      throw new Error("Forbidden initialization marker table access");
    if (sql.startsWith("SELECT event_state FROM ef_events")) {
      expect(values).toEqual([EVENT_ID, ORGANIZATION_ID]);
      return [
        store.event?.id === EVENT_ID &&
        store.event.tenant_id === ORGANIZATION_ID
          ? [{ event_state: store.event.event_state }]
          : [],
        [],
      ];
    }
    if (!this.working) throw new Error("Write outside mock transaction");
    if (sql.startsWith("UPDATE ef_events")) {
      expect(values.slice(1)).toEqual([EVENT_ID, ORGANIZATION_ID]);
      store.event!.event_state = values[0] as string;
      return [{ affectedRows: this.affectedRows }, []];
    }
    throw new Error("Unexpected mock SQL");
  }
}

const run = (fake: FakeConnection, mode: ConsumptionRuleMode = "dry-run") =>
  setPositiveSpringConsumptionRule(fake.asConnection(), { mode, now: NOW });
const state = (fake: FakeConnection) =>
  JSON.parse(fake.committed.event!.event_state) as EventAggregate;
const writes = (fake: FakeConnection) =>
  fake.calls.filter(call =>
    /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|SET)/i.test(call.sql)
  );

function mutateState(
  fake: FakeConnection,
  mutation: (aggregate: EventAggregate) => void
) {
  const aggregate = state(fake);
  mutation(aggregate);
  fake.committed.event!.event_state = JSON.stringify(aggregate);
}

function markedFixture(): EventAggregate {
  return planPositiveSpringConsumptionRule(eventRow(), {
    mode: "apply",
    now: NOW,
  }).aggregate;
}

type AuditMarker = EventAggregate["audit"][number];
function changeMarkerDetail(
  marker: AuditMarker,
  field: string,
  value: unknown
) {
  const detail = JSON.parse(marker.detail);
  if (value === undefined) delete detail[field];
  else detail[field] = value;
  marker.detail = JSON.stringify(detail);
}

const INVALID_MARKERS: [string, (marker: AuditMarker) => void][] = [
  [
    "wrong actor",
    marker => {
      marker.actor = "user:1";
    },
  ],
  [
    "wrong action",
    marker => {
      marker.action = "settings.updated";
    },
  ],
  [
    "invalid date",
    marker => {
      marker.createdAt = "invalid";
    },
  ],
  [
    "missing date",
    marker => {
      delete (marker as Partial<AuditMarker>).createdAt;
    },
  ],
  [
    "non-string date",
    marker => {
      Object.assign(marker, { createdAt: 0 });
    },
  ],
  [
    "impossible calendar date",
    marker => {
      marker.createdAt = "2026-02-30T00:00:00.000Z";
    },
  ],
  [
    "invalid JSON",
    marker => {
      marker.detail = "password=secret private-reference";
    },
  ],
  [
    "null detail",
    marker => {
      marker.detail = "null";
    },
  ],
  [
    "array detail",
    marker => {
      marker.detail = "[]";
    },
  ],
  [
    "numeric detail",
    marker => {
      marker.detail = "50000";
    },
  ],
  [
    "string detail",
    marker => {
      marker.detail = '"not an object"';
    },
  ],
  [
    "non-string detail",
    marker => {
      Object.assign(marker, { detail: {} });
    },
  ],
  [
    "wrong marker key",
    marker => changeMarkerDetail(marker, "markerKey", "wrong"),
  ],
  ["wrong event", marker => changeMarkerDetail(marker, "eventId", "wrong")],
  [
    "wrong organization",
    marker => changeMarkerDetail(marker, "organizationId", "wrong"),
  ],
  [
    "wrong threshold",
    marker => changeMarkerDetail(marker, "thresholdCents", 100_000),
  ],
  [
    "string threshold",
    marker => changeMarkerDetail(marker, "thresholdCents", "50000"),
  ],
  [
    "wrong accumulation",
    marker => changeMarkerDetail(marker, "accumulation", "per_transaction"),
  ],
  ...[
    "markerKey",
    "eventId",
    "organizationId",
    "thresholdCents",
    "accumulation",
  ].map(
    field =>
      [
        `missing ${field}`,
        (marker: AuditMarker) => changeMarkerDetail(marker, field, undefined),
      ] as [string, (marker: AuditMarker) => void]
  ),
];

describe("positive spring consumption rule pure planner (no database)", () => {
  it("projects only the new rule and a sanitized audit while preserving every historical array", () => {
    const row = eventRow();
    const before = structuredClone(row);
    const original = JSON.parse(row.event_state);
    original.futureFeature = { preserve: "yes" };
    original.event.futureSetting = "preserve too";
    row.event_state = JSON.stringify(original);
    const plan = planPositiveSpringConsumptionRule(row, {
      mode: "dry-run",
      now: NOW,
    });
    expect(plan.changed).toBe(true);
    expect(plan.aggregate.event).toEqual({
      ...original.event,
      thresholdCents: 50_000,
      accumulation: "cumulative",
      ruleVersion: 8,
    });
    for (const field of [
      "guests",
      "tables",
      "merchants",
      "receipts",
      "payments",
      "prizes",
      "draws",
      "ledger",
    ] as const) {
      expect(plan.aggregate[field]).toEqual(original[field]);
    }
    expect(plan.aggregate.audit.slice(0, -1)).toEqual(original.audit);
    expect(plan.aggregate.audit.at(-1)).toEqual({
      id: `${CONSUMPTION_RULE_MARKER_KEY}:audit`,
      actor: CONSUMPTION_RULE_ACTOR,
      action: "event.consumption-rule.updated",
      createdAt: NOW.toISOString(),
      detail: JSON.stringify({
        markerKey: CONSUMPTION_RULE_MARKER_KEY,
        eventId: EVENT_ID,
        organizationId: ORGANIZATION_ID,
        thresholdCents: 50_000,
        accumulation: "cumulative",
        ruleVersion: 8,
        changedAt: NOW.toISOString(),
      }),
    });
    expect(
      (plan.aggregate as EventAggregate & { futureFeature: unknown })
        .futureFeature
    ).toEqual(original.futureFeature);
    expect(
      planPositiveSpringConsumptionRule(row, { mode: "dry-run", now: NOW })
    ).toEqual(plan);
    expect(row).toEqual({ ...before, event_state: JSON.stringify(original) });
    const output = JSON.stringify(plan.report);
    expect(output).not.toMatch(
      /Private|private-reference|private-ticket|private@example|ruleVersion|tenantId/
    );
    expect(plan.report).toEqual({
      name: "正向春茗",
      eventStatus: "draft",
      mode: "dry-run",
      status: "would_change",
      current: { thresholdCents: 100_000, accumulation: "per_transaction" },
      projected: { thresholdCents: 50_000, accumulation: "cumulative" },
      receiptCount: 4,
    });
  });

  it.each([
    "row event",
    "row organization",
    "state event",
    "state organization",
    "slug",
  ])("rejects wrong %s identity", problem => {
    const row = eventRow();
    const aggregate = JSON.parse(row.event_state);
    if (problem === "row event") row.id = "different";
    if (problem === "row organization") row.tenant_id = "different";
    if (problem === "state event") aggregate.event.id = "different";
    if (problem === "state organization")
      aggregate.event.tenantId = "different";
    if (problem === "slug") aggregate.event.slug = "different";
    row.event_state = JSON.stringify(aggregate);
    expect(() =>
      planPositiveSpringConsumptionRule(row, { mode: "apply", now: NOW })
    ).toThrow("識別碼不符");
  });

  it.each([
    "guests",
    "tables",
    "merchants",
    "receipts",
    "payments",
    "prizes",
    "draws",
    "ledger",
    "audit",
  ])("requires actual aggregate array %s", field => {
    const row = eventRow();
    const aggregate = JSON.parse(row.event_state);
    aggregate[field] = {};
    row.event_state = JSON.stringify(aggregate);
    expect(() =>
      planPositiveSpringConsumptionRule(row, { mode: "apply", now: NOW })
    ).toThrow("不完整");
  });

  it.each(["not-json", "null", "[]", '{"version":2}', '{"event":[]}'])(
    "rejects malformed aggregate %s",
    event_state => {
      expect(() =>
        planPositiveSpringConsumptionRule(
          { ...eventRow(), event_state },
          { mode: "apply", now: NOW }
        )
      ).toThrow(ConsumptionRuleError);
    }
  );

  it.each([
    0,
    -1,
    0.5,
    "1",
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER,
  ])("rejects unsafe baseline version %s", ruleVersion => {
    const aggregate = fixture();
    aggregate.event.ruleVersion = ruleVersion as number;
    expect(() =>
      planPositiveSpringConsumptionRule(eventRow(aggregate), {
        mode: "apply",
        now: NOW,
      })
    ).toThrow(/版本/);
  });

  it("accepts an already-target safe maximum version without increment", () => {
    const aggregate = fixture();
    Object.assign(aggregate.event, {
      thresholdCents: 50_000,
      accumulation: "cumulative",
      ruleVersion: Number.MAX_SAFE_INTEGER,
    });
    const plan = planPositiveSpringConsumptionRule(eventRow(aggregate), {
      mode: "apply",
      now: NOW,
    });
    expect(plan.changed).toBe(true);
    expect(plan.report.status).toBe("already_target");
    expect(plan.aggregate.event).toEqual(aggregate.event);
    expect(plan.aggregate).toEqual({
      ...aggregate,
      audit: [...aggregate.audit, plan.aggregate.audit.at(-1)],
    });
    expect(JSON.parse(plan.aggregate.audit.at(-1)!.detail).ruleVersion).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });
});

describe("positive spring one-time connection workflow (mock only)", () => {
  it("defaults to strictly SELECT-only dry-run, without locks, BEGIN, commit, rollback or writes", async () => {
    const fake = new FakeConnection();
    const before = structuredClone(fake.committed);
    expect(
      (await setPositiveSpringConsumptionRule(fake.asConnection())).status
    ).toBe("would_change");
    expect(fake.calls).toEqual([
      {
        sql: "SELECT event_state FROM ef_events WHERE id = ? AND tenant_id = ?",
        values: [EVENT_ID, ORGANIZATION_ID],
      },
    ]);
    expect(
      fake.calls.every(
        call =>
          call.sql.startsWith("SELECT ") && !call.sql.includes("FOR UPDATE")
      )
    ).toBe(true);
    expect(
      fake.calls.some(call =>
        /owner_user_id IS|GET_LOCK|RELEASE_LOCK/.test(call.sql)
      )
    ).toBe(false);
    expect(writes(fake)).toEqual([]);
    expect([fake.beginCount, fake.commitCount, fake.rollbackCount]).toEqual([
      0, 0, 0,
    ]);
    expect(fake.committed).toEqual(before);
  });

  it.each([null, 123])(
    "applies for legitimate owner %s with only an event row lock and no ownership or timestamp edits",
    async owner => {
      const fake = new FakeConnection();
      fake.committed.event!.owner_user_id = owner;
      const before = structuredClone(fake.committed);
      const original = state(fake);
      const report = await run(fake, "apply");
      expect(report.status).toBe("applied");
      expect(state(fake).event).toEqual({
        ...original.event,
        thresholdCents: 50_000,
        accumulation: "cumulative",
        ruleVersion: 8,
      });
      for (const field of [
        "guests",
        "tables",
        "merchants",
        "receipts",
        "payments",
        "prizes",
        "draws",
        "ledger",
      ] as const) {
        expect(state(fake)[field]).toEqual(original[field]);
      }
      expect(state(fake).audit.slice(0, -1)).toEqual(original.audit);
      expect(fake.committed.event).toEqual({
        ...before.event!,
        event_state: JSON.stringify(state(fake)),
      });
      expect(fake.committed.markers[INITIALIZATION_MARKER_KEY]).toEqual(
        before.markers[INITIALIZATION_MARKER_KEY]
      );
      expect(fake.committed.markers).toEqual(before.markers);
      expect(state(fake).audit.at(-1)).toMatchObject({
        id: `${CONSUMPTION_RULE_MARKER_KEY}:audit`,
        actor: CONSUMPTION_RULE_ACTOR,
        action: "event.consumption-rule.updated",
      });
      expect(fake.calls[0]!.sql).toBe(
        "SELECT event_state FROM ef_events WHERE id = ? AND tenant_id = ? FOR UPDATE"
      );
      expect(fake.calls).toHaveLength(2);
      expect(
        fake.calls.some(call => /ef_initialization_markers/.test(call.sql))
      ).toBe(false);
      expect(writes(fake).map(call => call.sql)).toEqual([
        "UPDATE ef_events SET event_state = ? WHERE id = ? AND tenant_id = ?",
      ]);
      expect([fake.beginCount, fake.commitCount, fake.rollbackCount]).toEqual([
        1, 1, 0,
      ]);
    }
  );

  it("records an already-target audit marker without incrementing or altering any other state", async () => {
    const fake = new FakeConnection();
    mutateState(fake, aggregate => {
      aggregate.event.thresholdCents = 50_000;
      aggregate.event.accumulation = "cumulative";
    });
    fake.committed.event!.event_state = JSON.stringify(state(fake), null, 2);
    const before = structuredClone(fake.committed);
    expect((await run(fake)).status).toBe("already_target");
    expect(fake.committed).toEqual(before);
    expect((await run(fake, "apply")).status).toBe("applied");
    const original = JSON.parse(before.event!.event_state) as EventAggregate;
    expect(state(fake)).toEqual({
      ...original,
      audit: [...original.audit, state(fake).audit.at(-1)],
    });
    expect(state(fake).event.ruleVersion).toBe(7);
    expect(JSON.parse(state(fake).audit.at(-1)!.detail).ruleVersion).toBe(7);
    expect(fake.committed.event).toEqual({
      ...before.event!,
      event_state: JSON.stringify(state(fake)),
    });
    expect(fake.committed.markers).toEqual(before.markers);
    expect(writes(fake)).toHaveLength(1);
    expect(writes(fake)[0]!.sql).toBe(
      "UPDATE ef_events SET event_state = ? WHERE id = ? AND tenant_id = ?"
    );
    fake.calls = [];
    const after = structuredClone(fake.committed);
    expect((await run(fake, "apply")).status).toBe("already_applied");
    expect(writes(fake)).toEqual([]);
    expect(fake.committed).toEqual(after);
  });

  it("a durable marker protects later user edits on both dry-run and apply", async () => {
    const fake = new FakeConnection();
    await run(fake, "apply");
    mutateState(fake, aggregate => {
      Object.assign(aggregate.event, {
        name: "Later user name",
        thresholdCents: 75_000,
        accumulation: "per_transaction",
        ruleVersion: 9,
        registrationOpen: true,
      });
    });
    fake.committed.event!.event_state = JSON.stringify(state(fake), null, 2);
    const before = structuredClone(fake.committed);
    fake.calls = [];
    expect((await run(fake)).status).toBe("already_applied");
    const report = await run(fake, "apply");
    expect(report.status).toBe("already_applied");
    expect(report.projected).toEqual(report.current);
    expect(report.current).toEqual({
      thresholdCents: 75_000,
      accumulation: "per_transaction",
    });
    expect(writes(fake)).toEqual([]);
    expect(fake.committed).toEqual(before);
    expect(state(fake).audit).toHaveLength(2);
  });

  it.each([
    "event",
    "organization",
    "state event",
    "state organization",
    "missing event",
  ])("fails closed and rolls back on wrong %s", async problem => {
    const fake = new FakeConnection();
    if (problem === "event") fake.committed.event!.id = "wrong";
    if (problem === "organization") fake.committed.event!.tenant_id = "wrong";
    if (problem === "state event")
      mutateState(fake, aggregate => {
        aggregate.event.id = "wrong";
      });
    if (problem === "state organization")
      mutateState(fake, aggregate => {
        aggregate.event.tenantId = "wrong";
      });
    if (problem === "missing event") fake.committed.event = null;
    const before = structuredClone(fake.committed);
    await expect(run(fake, "apply")).rejects.toThrow(ConsumptionRuleError);
    expect(fake.committed).toEqual(before);
    expect(writes(fake)).toEqual([]);
    expect(fake.rollbackCount).toBe(1);
  });

  it.each([
    [75_000, "cumulative"],
    [50_000, "per_transaction"],
    [100_000, "cumulative"],
  ] as const)(
    "rejects unexpected rule %s/%s without overwriting user settings",
    async (thresholdCents, accumulation) => {
      const fake = new FakeConnection();
      mutateState(fake, aggregate =>
        Object.assign(aggregate.event, { thresholdCents, accumulation })
      );
      const before = structuredClone(fake.committed);
      await expect(run(fake)).rejects.toThrow("人工審核");
      expect(fake.beginCount).toBe(0);
      await expect(run(fake, "apply")).rejects.toThrow("人工審核");
      expect(fake.rollbackCount).toBe(1);
      expect(writes(fake)).toEqual([]);
      expect(fake.committed).toEqual(before);
    }
  );

  it.each(["SELECT event_state", "UPDATE ef_events", "COMMIT"])(
    "rolls back atomically and sanitizes driver failures at %s",
    async failOn => {
      const fake = new FakeConnection();
      fake.failOn = failOn;
      const before = structuredClone(fake.committed);
      await expect(run(fake, "apply")).rejects.toThrow("消費規則更新未完成");
      expect(fake.committed).toEqual(before);
      expect(fake.rollbackCount).toBe(1);
      expect(fake.commitCount).toBe(0);
    }
  );

  it("works with the occupied legacy unique marker slot without accessing or removing initialization markers", async () => {
    const fake = new FakeConnection();
    const before = structuredClone(fake.committed);
    expect((await run(fake, "apply")).status).toBe("applied");
    expect(fake.committed.markers).toEqual(before.markers);
    expect(
      fake.calls.every(call => !call.sql.includes("ef_initialization_markers"))
    ).toBe(true);
    expect(fake.rollbackCount).toBe(0);
  });

  it.each([0, 2])(
    "requires exactly one affected event row and rolls back on mismatch %s",
    async affectedRows => {
      const fake = new FakeConnection();
      fake.affectedRows = affectedRows;
      const before = structuredClone(fake.committed);
      await expect(run(fake, "apply")).rejects.toThrow("筆數不正確");
      expect(fake.committed).toEqual(before);
      expect(fake.rollbackCount).toBe(1);
      expect(fake.calls.some(call => call.sql.startsWith("INSERT"))).toBe(
        false
      );
    }
  );

  it("rejects unsupported runtime modes before executing any SQL", async () => {
    const fake = new FakeConnection();
    await expect(
      setPositiveSpringConsumptionRule(fake.asConnection(), {
        mode: "unexpected" as ConsumptionRuleMode,
      })
    ).rejects.toThrow("只允許");
    expect(fake.calls).toEqual([]);
    expect(fake.beginCount).toBe(0);
  });
});

describe("durable aggregate audit marker validation (mock only)", () => {
  it.each(INVALID_MARKERS)(
    "pure planner fails closed for %s",
    (_problem, corrupt) => {
      const aggregate = markedFixture();
      corrupt(aggregate.audit.at(-1)!);
      const row = eventRow(aggregate);
      const before = structuredClone(row);
      for (const mode of ["dry-run", "apply"] as const) {
        expect(() =>
          planPositiveSpringConsumptionRule(row, { mode, now: NOW })
        ).toThrow(ConsumptionRuleError);
      }
      expect(row).toEqual(before);
    }
  );

  it.each(INVALID_MARKERS)(
    "connection fails closed and rolls back for %s",
    async (_problem, corrupt) => {
      const fake = new FakeConnection();
      const aggregate = markedFixture();
      corrupt(aggregate.audit.at(-1)!);
      fake.committed.event = eventRow(aggregate);
      const before = structuredClone(fake.committed);
      await expect(run(fake)).rejects.toThrow(ConsumptionRuleError);
      expect(fake.beginCount).toBe(0);
      await expect(run(fake, "apply")).rejects.toThrow(ConsumptionRuleError);
      expect(fake.rollbackCount).toBe(1);
      expect(fake.commitCount).toBe(0);
      expect(writes(fake)).toEqual([]);
      expect(fake.committed).toEqual(before);
    }
  );

  it.each(["valid", "malformed"])(
    "rejects duplicate stable marker IDs including a %s duplicate",
    async duplicate => {
      const aggregate = markedFixture();
      const marker = structuredClone(aggregate.audit.at(-1)!);
      if (duplicate === "malformed") marker.detail = "not JSON";
      aggregate.audit.push(marker);
      const row = eventRow(aggregate);
      expect(() =>
        planPositiveSpringConsumptionRule(row, { mode: "apply", now: NOW })
      ).toThrow("不唯一");
      const fake = new FakeConnection();
      fake.committed.event = row;
      const before = structuredClone(fake.committed);
      await expect(run(fake)).rejects.toThrow("不唯一");
      await expect(run(fake, "apply")).rejects.toThrow("不唯一");
      expect(writes(fake)).toEqual([]);
      expect(fake.rollbackCount).toBe(1);
      expect(fake.committed).toEqual(before);
    }
  );

  it("does not treat matching detail or an external option without the stable audit ID as applied", () => {
    const aggregate = fixture();
    const marker = markedFixture().audit.at(-1)!;
    marker.id = "user-controlled-audit-id";
    aggregate.audit.push(marker);
    const plan = planPositiveSpringConsumptionRule(eventRow(aggregate), {
      mode: "apply",
      now: NOW,
    });
    expect(plan.changed).toBe(true);
    expect(plan.report.status).toBe("would_change");
    expect(plan.aggregate.audit.slice(0, -1)).toEqual(aggregate.audit);
    expect(plan.aggregate.audit.at(-1)!.id).toBe(
      `${CONSUMPTION_RULE_MARKER_KEY}:audit`
    );

    aggregate.event.thresholdCents = 75_000;
    const options = {
      mode: "apply" as const,
      now: NOW,
      marker: { organization_id: ORGANIZATION_ID, event_id: EVENT_ID },
    };
    expect(() =>
      planPositiveSpringConsumptionRule(eventRow(aggregate), options)
    ).toThrow("人工審核");
  });

  it("derives completion solely from aggregate audit and preserves later user rules", () => {
    const aggregate = markedFixture();
    Object.assign(aggregate.event, {
      thresholdCents: 123_456,
      accumulation: "per_transaction",
      ruleVersion: 42,
      name: "User's later event name",
      status: "live",
    });
    const row = eventRow(aggregate);
    for (const mode of ["dry-run", "apply"] as const) {
      const plan = planPositiveSpringConsumptionRule(row, {
        mode,
        now: new Date(NaN),
      });
      expect(plan.changed).toBe(false);
      expect(plan.aggregate).toEqual(aggregate);
      expect(plan.report.status).toBe("already_applied");
      expect(plan.report.projected).toEqual(plan.report.current);
    }
  });

  it("repeated apply and dry-run never update state bytes, bump versions or append another audit", async () => {
    const fake = new FakeConnection();
    expect((await run(fake, "apply")).status).toBe("applied");
    const before = structuredClone(fake.committed);
    fake.calls = [];
    for (const mode of ["apply", "dry-run", "apply"] as const) {
      expect((await run(fake, mode)).status).toBe("already_applied");
      expect(fake.committed).toEqual(before);
    }
    expect(writes(fake)).toEqual([]);
    expect(fake.calls).toHaveLength(3);
    expect(state(fake).event.ruleVersion).toBe(8);
    expect(
      state(fake).audit.filter(
        audit => audit.id === `${CONSUMPTION_RULE_MARKER_KEY}:audit`
      )
    ).toHaveLength(1);
  });

  it.each(["baseline", "already target"])(
    "rejects invalid operation dates without writes for %s",
    async current => {
      const fake = new FakeConnection();
      if (current === "already target")
        mutateState(fake, aggregate => {
          aggregate.event.thresholdCents = 50_000;
          aggregate.event.accumulation = "cumulative";
        });
      const before = structuredClone(fake.committed);
      for (const mode of ["dry-run", "apply"] as const) {
        await expect(
          setPositiveSpringConsumptionRule(fake.asConnection(), {
            mode,
            now: new Date(NaN),
          })
        ).rejects.toThrow("操作日期");
      }
      expect(writes(fake)).toEqual([]);
      expect(fake.committed).toEqual(before);
      expect(fake.rollbackCount).toBe(1);
    }
  );

  it.each(["UPDATE ef_events", "COMMIT", "affected rows"])(
    "rolls back an already-target audit-only update at %s",
    async failure => {
      const fake = new FakeConnection();
      mutateState(fake, aggregate => {
        aggregate.event.thresholdCents = 50_000;
        aggregate.event.accumulation = "cumulative";
      });
      if (failure === "affected rows") fake.affectedRows = 0;
      else fake.failOn = failure;
      const before = structuredClone(fake.committed);
      await expect(run(fake, "apply")).rejects.toThrow(ConsumptionRuleError);
      expect(fake.committed).toEqual(before);
      expect(fake.rollbackCount).toBe(1);
      expect(fake.commitCount).toBe(0);
    }
  );
});

describe("positive spring CLI safety (injected connector, no network)", () => {
  it("defaults to dry-run and accepts only one explicit --apply or --dry-run", () => {
    expect(parseConsumptionRuleMode([])).toBe("dry-run");
    expect(parseConsumptionRuleMode(["--dry-run"])).toBe("dry-run");
    expect(parseConsumptionRuleMode(["--apply"])).toBe("apply");
    for (const args of [
      ["--force"],
      ["--apply", "--dry-run"],
      ["--apply", "--apply"],
      ["--confirm-new-empty-database"],
      ["other"],
    ]) {
      expect(() => parseConsumptionRuleMode(args)).toThrow("用法");
    }
  });

  it("uses the initializer URI/charset/timezone/single-statement restrictions and allows only ssl parameters", () => {
    expect(consumptionRuleConnectionOptions(FAKE_URL)).toEqual({
      uri: FAKE_URL,
      charset: "UTF8MB4_UNICODE_CI",
      timezone: "Z",
      multipleStatements: false,
    });
    expect(consumptionRuleConnectionOptions(`${FAKE_URL}?ssl=true`).uri).toBe(
      `${FAKE_URL}?ssl=true`
    );
    for (const key of [
      "host",
      "database",
      "port",
      "user",
      "password",
      "socketPath",
      "multipleStatements",
      "timezone",
      "charset",
      "uri",
      "SSL",
    ]) {
      expect(() =>
        consumptionRuleConnectionOptions(`${FAKE_URL}?ssl=true&${key}=override`)
      ).toThrow("只允許 ssl");
    }
    for (const raw of [
      undefined,
      "",
      "bad-url",
      "postgres://host/db",
      "mysql:///db",
      "mysql://host",
      "mysql://host/",
    ]) {
      expect(() => consumptionRuleConnectionOptions(raw)).toThrow(
        ConsumptionRuleError
      );
    }
  });

  it("invalid args or unsafe URL never call the connector", async () => {
    const connect = vi.fn();
    await expect(
      runPositiveSpringConsumptionRuleCli(["--force"], FAKE_URL, connect)
    ).rejects.toThrow("用法");
    await expect(
      runPositiveSpringConsumptionRuleCli([], `${FAKE_URL}?host=evil`, connect)
    ).rejects.toThrow("只允許 ssl");
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([{ args: [] }, { args: ["--dry-run"] }, { args: ["--apply"] }])(
    "always closes its injected connection for $args",
    async ({ args }) => {
      const fake = new FakeConnection();
      const connect = vi.fn(async () => fake.asConnection());
      const report = await runPositiveSpringConsumptionRuleCli(
        args,
        FAKE_URL,
        connect
      );
      expect(report.mode).toBe(args[0] === "--apply" ? "apply" : "dry-run");
      expect(connect).toHaveBeenCalledWith(
        consumptionRuleConnectionOptions(FAKE_URL)
      );
      expect(fake.endCount).toBe(1);
      if (report.mode === "dry-run") expect(writes(fake)).toEqual([]);
    }
  );

  it.each(["query", "identity", "rollback", "close"])(
    "always closes and sanitizes on %s failure",
    async failure => {
      const fake = new FakeConnection();
      if (failure === "query" || failure === "rollback")
        fake.failOn = "UPDATE ef_events";
      if (failure === "rollback") fake.failRollback = true;
      if (failure === "identity") fake.committed.event!.tenant_id = "wrong";
      if (failure === "close") fake.failClose = true;
      let error: unknown;
      try {
        await runPositiveSpringConsumptionRuleCli(
          ["--apply"],
          FAKE_URL,
          async () => fake.asConnection()
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConsumptionRuleError);
      expect((error as Error).message).not.toMatch(
        /secret|password|SQL|private-reference|fake_user|fake_password|not-a-real-host/
      );
      expect(fake.endCount).toBe(1);
    }
  );

  it("sanitizes connection creation errors without logging credentials or SQL", async () => {
    await expect(
      runPositiveSpringConsumptionRuleCli([], FAKE_URL, async () => {
        throw new Error(
          `Connection failed ${FAKE_URL} driver SQL password=secret`
        );
      })
    ).rejects.toThrow("消費規則更新未完成");
  });
});
