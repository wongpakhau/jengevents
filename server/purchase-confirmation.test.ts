import { describe, expect, it } from "vitest";
import type { Receipt } from "../shared/eventflow";
import { availableChances, type EventAggregate } from "./eventflow/engine";
import { merchantSettlement } from "./eventflow/accounting";
import { decideReceipt } from "./eventflow/purchase-confirmation";

const now = new Date("2027-01-01T00:00:00.000Z");
function fixture() {
  const guest = {
    id: "guest",
    tenantId: "tenant",
    eventId: "event",
    name: "Guest",
    email: "",
    phone: "",
    group: "",
    note: "",
    ticket: "000001",
    checkedInAt: null,
    tableId: null,
    seat: null,
    chances: 0,
    createdAt: now.toISOString(),
  };
  const aggregate = {
    version: 1,
    event: {
      id: "event",
      tenantId: "tenant",
      thresholdCents: 50000,
      ruleVersion: 2,
      accumulation: "cumulative",
    },
    guests: [guest],
    receipts: [],
    ledger: [],
    merchants: [],
    payments: [],
    tables: [],
    prizes: [],
    draws: [],
    audit: [],
  } as unknown as EventAggregate;
  const receipt = (id: string, amountCents: number): Receipt => ({
    id,
    tenantId: "tenant",
    eventId: "event",
    merchantId: "merchant",
    amountCents,
    feeCents: amountCents / 10,
    status: "pending",
    intendedGuestId: guest.id,
    confirmationRequired: true,
    guestId: null,
    claimedAt: null,
    createdAt: now.toISOString(),
    expiresAt: "2027-01-02T00:00:00.000Z",
    reference: id,
    ruleVersion: 2,
    thresholdCents: 50000,
    accumulation: "cumulative",
    chances: 0,
  });
  return { aggregate, guest, receipt };
}

describe("guest-bound receipt decisions", () => {
  it("keeps pending and rejected sales/chances at zero; HK$300 + HK$200 earns one", () => {
    const { aggregate, guest, receipt } = fixture();
    aggregate.receipts.push(
      receipt("a", 30000),
      receipt("b", 20000),
      receipt("reject", 90000)
    );
    const merchant = {
      id: "merchant",
      tenantId: "tenant",
      eventId: "event",
      name: "Merchant",
      active: true,
      createdAt: now.toISOString(),
    };
    expect(
      merchantSettlement(merchant, aggregate.receipts, []).salesCents
    ).toBe(0);
    expect(availableChances(aggregate, guest.id)).toBe(0);
    expect(
      decideReceipt(aggregate, aggregate.receipts[0], guest, true, now).gained
    ).toBe(0);
    const result = decideReceipt(
      aggregate,
      aggregate.receipts[1],
      guest,
      true,
      now
    );
    expect(result).toMatchObject({
      gained: 1,
      total: 1,
      alreadyClaimed: false,
    });
    expect(result.receipt).toMatchObject({
      status: "valid",
      guestId: guest.id,
      claimedAt: now.toISOString(),
      decisionAt: now.toISOString(),
    });
    expect(
      decideReceipt(aggregate, aggregate.receipts[2], guest, false, now)
    ).toMatchObject({
      gained: 0,
      total: 1,
      receipt: { status: "rejected", guestId: null },
    });
    expect(merchantSettlement(merchant, aggregate.receipts, [])).toMatchObject({
      salesCents: 50000,
      dueCents: 5000,
    });
    expect(aggregate.ledger).toHaveLength(1);
  });
  it("HK$1000 earns two and duplicate decisions never add ledger entries", () => {
    const { aggregate, guest, receipt } = fixture();
    aggregate.receipts.push(receipt("a", 100000));
    expect(
      decideReceipt(aggregate, aggregate.receipts[0], guest, true, now).gained
    ).toBe(2);
    expect(
      decideReceipt(aggregate, aggregate.receipts[0], guest, true, now)
    ).toMatchObject({ gained: 0, total: 2, alreadyClaimed: true });
    expect(aggregate.ledger).toHaveLength(1);
    expect(() =>
      decideReceipt(aggregate, aggregate.receipts[0], guest, false, now)
    ).toThrowError(
      expect.objectContaining({ code: "RECEIPT_DECISION_CONFLICT" })
    );
  });
  it("duplicate rejection is safe and a later confirmation fails closed", () => {
    const { aggregate, guest, receipt } = fixture();
    aggregate.receipts.push(receipt("a", 100000));
    decideReceipt(aggregate, aggregate.receipts[0], guest, false, now);
    expect(
      decideReceipt(aggregate, aggregate.receipts[0], guest, false, now)
    ).toMatchObject({ gained: 0, alreadyClaimed: true });
    expect(() =>
      decideReceipt(aggregate, aggregate.receipts[0], guest, true, now)
    ).toThrowError(
      expect.objectContaining({ code: "RECEIPT_DECISION_CONFLICT" })
    );
    expect(aggregate.ledger).toHaveLength(0);
  });
  it("uses historical per-transaction and cumulative snapshots, never current event settings", () => {
    const { aggregate, guest, receipt } = fixture();
    aggregate.event.thresholdCents = 100;
    aggregate.event.ruleVersion = 10;
    aggregate.receipts.push(
      {
        ...receipt("old", 100000),
        ruleVersion: 1,
        thresholdCents: 100000,
        accumulation: "per_transaction",
      },
      receipt("a", 30000),
      receipt("b", 20000)
    );
    expect(
      decideReceipt(aggregate, aggregate.receipts[0], guest, true, now).gained
    ).toBe(1);
    expect(
      decideReceipt(aggregate, aggregate.receipts[1], guest, true, now).gained
    ).toBe(0);
    expect(
      decideReceipt(aggregate, aggregate.receipts[2], guest, true, now)
    ).toMatchObject({ gained: 1, total: 2 });
  });
  it.each([
    ["wrong guest", { intendedGuestId: "other" }, "RECEIPT_GUEST_SCOPE"],
    ["another assigned guest", { guestId: "other" }, "RECEIPT_GUEST_SCOPE"],
    ["legacy", { confirmationRequired: false }, "RECEIPT_GUEST_SCOPE"],
    ["cross event", { eventId: "other" }, "CROSS_EVENT"],
    ["void", { status: "void" }, "RECEIPT_VOID"],
    ["expired", { expiresAt: now.toISOString() }, "RECEIPT_EXPIRED"],
    ["malformed expiry", { expiresAt: "invalid" }, "RECEIPT_EXPIRED"],
    ["pending corrupt", { chances: 1 }, "RECEIPT_STATE_INVALID"],
  ])("rejects %s without changing the aggregate", (_label, changes, code) => {
    const { aggregate, guest, receipt } = fixture();
    aggregate.receipts.push({ ...receipt("a", 100000), ...changes } as Receipt);
    const before = JSON.stringify(aggregate);
    expect(() =>
      decideReceipt(aggregate, aggregate.receipts[0], guest, true, now)
    ).toThrowError(expect.objectContaining({ code }));
    expect(JSON.stringify(aggregate)).toBe(before);
  });
});
