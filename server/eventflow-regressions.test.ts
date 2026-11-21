import { describe, it, expect } from "vitest";
import type { Merchant, Receipt, Payment } from "../shared/eventflow";
import { merchantSettlement, accountingCsv } from "./eventflow/accounting";
import {
  availableChances,
  feeForCents,
  buildDrawSnapshot,
  type LedgerEntry,
} from "./eventflow/engine";
import { validLogoAddress } from "../shared/brand";
import { assertSameOriginJson } from "./eventflow/security";
const merchant: Merchant = {
  id: "m",
  tenantId: "t",
  eventId: "e",
  name: "=INVALIDFORMULA",
  active: true,
  createdAt: "2026-10-30",
};
const receipt = (id: string, status: "valid" | "void"): Receipt => ({
  id,
  tenantId: "t",
  eventId: "e",
  merchantId: "m",
  amountCents: 100000,
  feeCents: 10000,
  status,
  guestId: "g",
  claimedAt: "2026-10-30",
  createdAt: "2026-10-30",
  expiresAt: "2026-10-31",
  reference: id,
  ruleVersion: 1,
  thresholdCents: 100000,
  accumulation: "per_transaction",
  chances: 1,
});
const payment: Payment = {
  id: "p",
  merchantId: "m",
  amountCents: 10000,
  reference: "payment-once",
  createdAt: "2026-10-30",
};
const ledger: LedgerEntry[] = [
  {
    id: "l1",
    guestId: "g",
    receiptId: "r1",
    ruleVersion: 1,
    delta: 1,
    kind: "claim",
    createdAt: "2026-10-30",
  },
  {
    id: "l2",
    guestId: "g",
    receiptId: "r2",
    ruleVersion: 1,
    delta: 1,
    kind: "claim",
    createdAt: "2026-10-30",
  },
];
describe("MVP review regressions", () => {
  it("charges 10% only on valid transactions after a void", () => {
    expect(
      merchantSettlement(
        merchant,
        [receipt("r1", "valid"), receipt("r2", "void")],
        [payment]
      )
    ).toMatchObject({
      salesCents: 100000,
      dueCents: 10000,
      paidCents: 10000,
      balanceCents: 0,
    });
  });
  it("preserves overpaid balance without automatic refund", () => {
    expect(
      merchantSettlement(merchant, [receipt("r1", "void")], [payment])
        .balanceCents
    ).toBe(-10000);
  });
  it("CSV includes each payment once and explicit void fee offset", () => {
    const csv = accountingCsv(
      [merchant],
      [receipt("r1", "valid"), receipt("r2", "void")],
      [payment]
    );
    expect(csv.split("payment-once")).toHaveLength(2);
    expect(csv).toContain('"-10000"');
    expect(csv).toContain("'=INVALIDFORMULA");
  });
  it("rounds 10% at each transaction with half-up cents", () => {
    expect(feeForCents(15)).toBe(2);
    expect(feeForCents(14)).toBe(1);
  });
  it("accepts stable storage or HTTPS but rejects unsupported schemes/traversal", () => {
    expect(validLogoAddress("/manus-storage/brand_logo.png")).toBe(true);
    expect(validLogoAddress("https://example.com/logo.png")).toBe(true);
    expect(validLogoAddress("manus-storage://logo")).toBe(false);
    expect(validLogoAddress("/manus-storage/../private")).toBe(false);
    expect(validLogoAddress("javascript:bad")).toBe(false);
  });
  it("retains history yet excludes voided rights from future draws", () => {
    expect(
      availableChances(
        { ledger, receipts: [receipt("r1", "valid"), receipt("r2", "void")] },
        "g"
      )
    ).toBe(1);
    expect(ledger.reduce((n, l) => n + l.delta, 0)).toBe(2);
  });
  it("retains cumulative remainder only for valid historical rule version", () => {
    const a = {
      ...receipt("r1", "valid"),
      amountCents: 60000,
      accumulation: "cumulative" as const,
    };
    const b = {
      ...receipt("r2", "valid"),
      amountCents: 60000,
      accumulation: "cumulative" as const,
    };
    expect(availableChances({ ledger, receipts: [a, b] }, "g")).toBe(1);
    expect(
      availableChances({ ledger, receipts: [a, { ...b, status: "void" }] }, "g")
    ).toBe(0);
  });
  it("allows browser-controlled same-origin Proxy metadata but denies cross-site", () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: "https://preview.example",
      host: "127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
    };
    const req = { get: (k: string) => headers[k], protocol: "http" } as any;
    expect(() => assertSameOriginJson(req)).not.toThrow();
    headers["sec-fetch-site"] = "cross-site";
    expect(() => assertSameOriginJson(req)).toThrow("跨站");
  });
});
