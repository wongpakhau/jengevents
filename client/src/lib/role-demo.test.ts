import { describe, expect, it } from "vitest";
import {
  applyRoleDemoAction,
  createRoleDemoState,
  DEMO_GUEST,
  DEMO_GUEST_QR,
  getDemoSummary,
  isDemoGuestCode,
  parseDemoAmountCents,
  parseRoleDemoState,
  ROLE_DEMO_STORAGE_KEY,
  serializeRoleDemoState,
  type DemoRole,
  type RoleDemoAction,
  type RoleDemoState,
} from "./role-demo";

const at = "2026-11-23T15:00:00.000Z";
function submit(state: RoleDemoState, amount: string, reference = "DEMO-001") {
  return applyRoleDemoAction(state, "merchant", {
    type: "submit",
    guestCode: DEMO_GUEST_QR,
    amount,
    reference,
    at,
  });
}
function decide(state: RoleDemoState, type: "confirm" | "reject", index = 0) {
  return applyRoleDemoAction(state, "guest", {
    type,
    receiptId: state.receipts[index].id,
    at,
  });
}

describe("isolated role demo fixtures", () => {
  it("uses only its own key and one explicitly named demo guest", () => {
    expect(ROLE_DEMO_STORAGE_KEY).toBe("eventflow.role-demo.v1");
    expect(DEMO_GUEST.name).toBe("示範用家");
    expect(createRoleDemoState().receipts).toEqual([]);
  });
  it("accepts only the exact demo guest code", () => {
    expect(isDemoGuestCode(DEMO_GUEST_QR)).toBe(true);
    for (const code of [
      "real-token",
      "/guest/abc",
      "https://example.test/guest/abc",
      "eventflow-demo:guest:other",
      `${DEMO_GUEST_QR} `,
    ]) {
      expect(isDemoGuestCode(code)).toBe(false);
      expect(() =>
        applyRoleDemoAction(createRoleDemoState(), "merchant", {
          type: "submit",
          guestCode: code,
          amount: "500",
          reference: "REF",
          at,
        })
      ).toThrow(/DEMO QR/);
    }
  });
});

describe("exact monetary inputs", () => {
  it.each([
    ["0.01", 1],
    ["1.1", 110],
    ["499", 49900],
    ["500.00", 50000],
    ["1000", 100000],
    [" 300.25 ", 30025],
  ])("converts %s into %i cents", (value, expected) => {
    expect(parseDemoAmountCents(value)).toBe(expected);
  });
  it.each([
    "",
    "0",
    "0.00",
    "-1",
    "+1",
    ".50",
    "1.",
    "1.001",
    "1,000",
    "1e3",
    "Infinity",
    "NaN",
    "01",
    "90071992547410",
  ])("rejects invalid amount %s", value => {
    expect(parseDemoAmountCents(value)).toBeNull();
    expect(() => submit(createRoleDemoState(), value)).toThrow(/金額/);
  });
});

describe("confirmed-spend chances", () => {
  it.each([
    ["499", 0, 49900, 100],
    ["500", 1, 0, 50000],
    ["1000", 2, 0, 50000],
  ])("%s HKD gives %i spending chances", (amount, chances, remainder, next) => {
    const pending = submit(createRoleDemoState(), amount);
    expect(getDemoSummary(pending).confirmedSpendCents).toBe(0);
    expect(getDemoSummary(pending).spendChances).toBe(0);
    const confirmed = decide(pending, "confirm");
    expect(getDemoSummary(confirmed)).toMatchObject({
      confirmedSpendCents: Number(amount) * 100,
      spendChances: chances,
      remainderCents: remainder,
      untilNextChanceCents: next,
      checkedInChances: 1,
    });
    expect(pending.receipts[0].status).toBe("pending");
  });
  it("combines HK$300 + HK$200 only when both are confirmed", () => {
    let state = submit(createRoleDemoState(), "300", "REF-A");
    state = submit(state, "200", "REF-B");
    state = decide(state, "confirm", 0);
    expect(getDemoSummary(state)).toMatchObject({
      confirmedSpendCents: 30000,
      spendChances: 0,
      remainderCents: 30000,
    });
    state = decide(state, "confirm", 1);
    expect(getDemoSummary(state)).toMatchObject({
      confirmedSpendCents: 50000,
      spendChances: 1,
      manualDueCents: 5000,
    });
  });
  it("pending and rejected receipts never increase spend or chances", () => {
    let state = submit(createRoleDemoState(), "1000", "REF-A");
    state = submit(state, "500", "REF-B");
    state = decide(state, "reject", 0);
    expect(getDemoSummary(state)).toMatchObject({
      confirmedSpendCents: 0,
      spendChances: 0,
      manualDueCents: 0,
      checkedInChances: 1,
      pendingCount: 1,
      rejectedCount: 1,
    });
  });
  it("keeps the single checked-in prize chance independent from spending and reset", () => {
    const state = decide(submit(createRoleDemoState(), "1000"), "confirm");
    expect(getDemoSummary(state).checkedInChances).toBe(1);
    const reset = applyRoleDemoAction(state, "admin", { type: "reset" });
    expect(getDemoSummary(reset)).toMatchObject({
      spendChances: 0,
      checkedInChances: 1,
    });
    expect(reset.receipts).toHaveLength(0);
    expect(state.receipts).toHaveLength(1);
  });
  it("rounds demo manual dues from the confirmed total to the nearest cent", () => {
    expect(
      getDemoSummary(decide(submit(createRoleDemoState(), "0.05"), "confirm"))
        .manualDueCents
    ).toBe(1);
  });
});

describe("receipt invariants", () => {
  it("requires a reference and prevents duplicate references regardless of status/case", () => {
    expect(() => submit(createRoleDemoState(), "500", "  ")).toThrow(
      /參考編號/
    );
    expect(() => submit(createRoleDemoState(), "500", "R".repeat(81))).toThrow(
      /參考編號/
    );
    const pending = submit(createRoleDemoState(), "500", "REF-A");
    for (const state of [
      pending,
      decide(pending, "confirm"),
      decide(pending, "reject"),
    ]) {
      expect(() => submit(state, "500", " ref-a ")).toThrow(/重複/);
      expect(state.receipts).toHaveLength(1);
    }
  });
  it.each(["confirm", "reject"] as const)(
    "does not allow duplicate or reversed %s decisions",
    decision => {
      const state = decide(submit(createRoleDemoState(), "1000"), decision);
      const before = getDemoSummary(state);
      expect(() => decide(state, "confirm")).toThrow(/已處理/);
      expect(() => decide(state, "reject")).toThrow(/已處理/);
      expect(getDemoSummary(state)).toEqual(before);
    }
  );
  it("rejects a decision on an unknown receipt", () => {
    expect(() =>
      applyRoleDemoAction(createRoleDemoState(), "guest", {
        type: "confirm",
        receiptId: "real-receipt",
        at,
      })
    ).toThrow(/找不到/);
  });
  it("rejects invalid transaction timestamps without changing state", () => {
    const state = createRoleDemoState();
    expect(() =>
      applyRoleDemoAction(state, "merchant", {
        type: "submit",
        guestCode: DEMO_GUEST_QR,
        amount: "500",
        reference: "R",
        at: "invalid",
      })
    ).toThrow(/時間/);
    expect(state.receipts).toHaveLength(0);
  });
});

describe("role checks inside the demo only", () => {
  const forbidden: [DemoRole, RoleDemoAction][] = [
    [
      "guest",
      {
        type: "submit",
        guestCode: DEMO_GUEST_QR,
        amount: "500",
        reference: "R",
        at,
      },
    ],
    [
      "admin",
      {
        type: "submit",
        guestCode: DEMO_GUEST_QR,
        amount: "500",
        reference: "R",
        at,
      },
    ],
    ["merchant", { type: "confirm", receiptId: "demo-receipt-1", at }],
    ["admin", { type: "confirm", receiptId: "demo-receipt-1", at }],
    ["merchant", { type: "reject", receiptId: "demo-receipt-1", at }],
    ["admin", { type: "reject", receiptId: "demo-receipt-1", at }],
    ["guest", { type: "reset" }],
    ["merchant", { type: "reset" }],
  ];
  it.each(forbidden)("refuses %s performing %j", (role, action) => {
    const state = submit(createRoleDemoState(), "500");
    expect(() => applyRoleDemoAction(state, role, action)).toThrow(/權限/);
    expect(state.receipts[0].status).toBe("pending");
    expect(getDemoSummary(state).spendChances).toBe(0);
  });
});

describe("shared demo serialization", () => {
  it("round-trips pending, confirmed and rejected demo receipts", () => {
    let state = submit(createRoleDemoState(), "300", "A");
    state = submit(state, "200", "B");
    state = submit(state, "499", "C");
    state = decide(state, "confirm", 0);
    state = decide(state, "reject", 1);
    expect(parseRoleDemoState(serializeRoleDemoState(state))).toEqual(state);
    expect(parseRoleDemoState(null)).toEqual(createRoleDemoState());
  });
  it("refuses corrupt storage and foreign production IDs", () => {
    expect(() => parseRoleDemoState("not-json")).toThrow(/示範資料/);
    const state = submit(createRoleDemoState(), "500");
    for (const replacement of [
      { guestId: "real-guest" },
      { merchantId: "real-merchant" },
      { amountCents: -1 },
      { status: "confirmed" },
    ]) {
      expect(() =>
        parseRoleDemoState(
          JSON.stringify({
            ...state,
            receipts: [{ ...state.receipts[0], ...replacement }],
          })
        )
      ).toThrow(/格式/);
    }
    expect(() =>
      parseRoleDemoState(
        JSON.stringify({
          ...state,
          receipts: [...state.receipts, state.receipts[0]],
        })
      )
    ).toThrow(/格式/);
  });
});
