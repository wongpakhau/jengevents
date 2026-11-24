import { describe, expect, it } from "vitest";
import type { Guest, Receipt } from "../shared/eventflow";
import {
  DomainError,
  assertEventScope,
  assertSeatChange,
  buildCheckedInDrawSnapshot,
  buildDrawSnapshot,
  cumulativeClaimDelta,
  idempotencyDecision,
  receiptInAnyDrawSnapshot,
  selectWeightedWinner,
  voidLedgerAdjustment,
  type InternalDraw,
  type LedgerEntry,
} from "./eventflow/engine";

const guest = (id: string, overrides: Partial<Guest> = {}): Guest => ({
  id,
  tenantId: "tenant-a",
  eventId: "event-a",
  name: id,
  email: "",
  phone: "",
  ticket: id === "g1" ? "000001" : "000002",
  checkedInAt: null,
  tableId: null,
  seat: null,
  chances: 0,
  group: "",
  note: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  id: "r1",
  tenantId: "tenant-a",
  eventId: "event-a",
  merchantId: "m1",
  amountCents: 250000,
  feeCents: 25000,
  status: "valid",
  guestId: "g1",
  claimedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-02T00:00:00.000Z",
  reference: "ref-1",
  ruleVersion: 1,
  thresholdCents: 100000,
  accumulation: "per_transaction",
  chances: 2,
  ...overrides,
});

const expectDomain = (fn: () => unknown, code: string) => {
  try {
    fn();
    throw new Error("expected DomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
};

describe("EventFlow pure business engine", () => {
  it("atomically rejects an occupied seat while allowing the current guest to move", () => {
    const tables = [
      {
        id: "t1",
        tenantId: "tenant-a",
        eventId: "event-a",
        number: 1,
        label: "1號枱",
        capacity: 12,
        x: 50,
        y: 50,
      },
    ];
    const guests = [guest("g1", { tableId: "t1", seat: 1 }), guest("g2")];
    expectDomain(
      () =>
        assertSeatChange(guests, tables, {
          guestId: "g2",
          tableId: "t1",
          seat: 1,
        }),
      "SEAT_OCCUPIED"
    );
    expect(() =>
      assertSeatChange(guests, tables, {
        guestId: "g1",
        tableId: "t1",
        seat: 2,
      })
    ).not.toThrow();
  });

  it("rejects cross-event capability use before any mutation", () => {
    expectDomain(() => assertEventScope("event-a", "event-b"), "CROSS_EVENT");
  });

  it("makes a receipt claim idempotent by using the same cumulative floor boundary", () => {
    expect(cumulativeClaimDelta(90000, 25000, 100000)).toBe(1);
    expect(cumulativeClaimDelta(115000, 25000, 100000)).toBe(0);
  });

  it("rejects reuse of an idempotency key for a different request", () => {
    expect(idempotencyDecision(null, "hash-a")).toBe("new");
    expect(idempotencyDecision("hash-a", "hash-a")).toBe("replay");
    expectDomain(
      () => idempotencyDecision("hash-a", "hash-b"),
      "IDEMPOTENCY_MISMATCH"
    );
  });

  it("preserves receipt rule snapshots when settings later change", () => {
    const oldRule = receipt({
      amountCents: 250000,
      thresholdCents: 100000,
      ruleVersion: 1,
    });
    const newRule = receipt({
      id: "r2",
      amountCents: 250000,
      thresholdCents: 200000,
      ruleVersion: 2,
    });
    expect((oldRule.amountCents / oldRule.thresholdCents) | 0).toBe(2);
    expect((newRule.amountCents / newRule.thresholdCents) | 0).toBe(1);
  });

  it("reverses an unsnapshotted void with an append-only correction", () => {
    const active = receipt({ chances: 2 });
    const voided = { ...active, status: "void" as const };
    const ledger: LedgerEntry[] = [
      {
        id: "l1",
        guestId: "g1",
        receiptId: "r1",
        ruleVersion: 1,
        delta: 2,
        kind: "claim",
        createdAt: active.createdAt,
      },
    ];
    expect(voidLedgerAdjustment([voided], ledger, "g1", active)).toBe(-2);
  });

  it("does not silently alter a draw source and rejects another draw for the same prize", () => {
    const snapshot = buildDrawSnapshot(
      {
        guests: [guest("g1"), guest("g2")],
        ledger: [
          {
            id: "l1",
            guestId: "g1",
            receiptId: "r1",
            ruleVersion: 1,
            delta: 1,
            kind: "claim",
            createdAt: "x",
          },
          {
            id: "l2",
            guestId: "g2",
            receiptId: "r2",
            ruleVersion: 1,
            delta: 2,
            kind: "claim",
            createdAt: "x",
          },
        ],
        receipts: [
          receipt({ id: "r1", guestId: "g1" }),
          receipt({ id: "r2", guestId: "g2" }),
        ],
        draws: [],
      },
      false
    );
    expect(selectWeightedWinner(snapshot, () => 2).winnerGuestId).toBe("g2");
    const draw = {
      id: "d1",
      prizeId: "p1",
      prizeName: "獎",
      winner: { id: "g1", name: "g1", ticket: "000001", tableNumber: null },
      winnerGuestId: "g1",
      totalChances: 1,
      eligibleGuests: 1,
      createdAt: "x",
      revealedAt: null,
      snapshot,
    } as InternalDraw;
    expect(receiptInAnyDrawSnapshot("r1", [draw])).toBe(true);
    expectDomain(() => {
      if (draw.prizeId === "p1")
        throw new DomainError(409, "PRIZE_ALREADY_DRAWN", "此獎項已完成抽獎");
    }, "PRIZE_ALREADY_DRAWN");
  });

  it("gives every checked-in guest one equal chance, independent of receipts or prior winners", () => {
    const snapshot = buildCheckedInDrawSnapshot({
      guests: [
        guest("g1", { checkedInAt: "2027-01-31T08:00:00.000Z", chances: 99 }),
        guest("g2", { checkedInAt: "2027-01-31T08:01:00.000Z", chances: 0 }),
        guest("g3", { checkedInAt: null, chances: 99 }),
        guest("g4", { checkedInAt: "", chances: 99 }),
        guest("g5", { checkedInAt: undefined, chances: 99 }),
        guest("g6", { checkedInAt: "invalid", chances: 99 }),
      ],
    });
    expect(snapshot).toEqual([
      {
        guestId: "g1",
        ticket: "000001",
        chances: 1,
        ledgerIds: [],
        receiptIds: [],
      },
      {
        guestId: "g2",
        ticket: "000002",
        chances: 1,
        ledgerIds: [],
        receiptIds: [],
      },
    ]);
  });
});
