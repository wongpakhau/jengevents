import { randomInt } from "node:crypto";
import { isExcludedFromEvent } from "../../shared/eventflow";
import type {
  Draw,
  EventInfo,
  EventTable,
  Guest,
  Receipt,
} from "../../shared/eventflow";

export type LedgerEntry = {
  id: string;
  guestId: string;
  receiptId: string | null;
  ruleVersion: number;
  delta: number;
  kind: "claim" | "void_adjustment";
  createdAt: string;
};

export type DrawSnapshotEntry = {
  guestId: string;
  ticket: string;
  chances: number;
  ledgerIds: string[];
  receiptIds: string[];
};

export type InternalDraw = Draw & {
  winnerGuestId: string;
  snapshot: DrawSnapshotEntry[];
};

export type EventAggregate = {
  version: 1;
  event: EventInfo;
  guests: Guest[];
  tables: EventTable[];
  merchants: import("../../shared/eventflow").Merchant[];
  receipts: Receipt[];
  payments: import("../../shared/eventflow").Payment[];
  prizes: import("../../shared/eventflow").Prize[];
  draws: InternalDraw[];
  ledger: LedgerEntry[];
  audit: import("../../shared/eventflow").Audit[];
};

export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new DomainError(status, code, message);
}

export function assertEventScope(
  expectedEventId: string,
  actualEventId: string
) {
  if (expectedEventId !== actualEventId) {
    fail(403, "CROSS_EVENT", "此憑證不屬於目前活動");
  }
}

export function integerCents(value: unknown, label = "金額"): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    fail(400, "INVALID_AMOUNT", `${label}必須為正整數分`);
  }
  if (value > 100_000_000) {
    fail(400, "AMOUNT_TOO_LARGE", `${label}超過可接受範圍`);
  }
  return value;
}

/** 10% and commercial half-up rounding to the nearest cent. */
export function feeForCents(amountCents: number): number {
  integerCents(amountCents);
  return Math.floor((amountCents * 10 + 50) / 100);
}

export function receiptChances(
  amountCents: number,
  thresholdCents: number
): number {
  integerCents(amountCents);
  integerCents(thresholdCents, "門檻");
  return Math.floor(amountCents / thresholdCents);
}

export function cumulativeClaimDelta(
  priorClaimedCents: number,
  amountCents: number,
  thresholdCents: number
): number {
  if (!Number.isSafeInteger(priorClaimedCents) || priorClaimedCents < 0) {
    fail(500, "INVALID_LEDGER", "權益帳本資料不正確");
  }
  return (
    Math.floor((priorClaimedCents + amountCents) / thresholdCents) -
    Math.floor(priorClaimedCents / thresholdCents)
  );
}

export function getLedgerBalance(
  ledger: readonly LedgerEntry[],
  guestId: string,
  ruleVersion?: number
): number {
  return ledger
    .filter(
      entry =>
        entry.guestId === guestId &&
        (ruleVersion === undefined || entry.ruleVersion === ruleVersion)
    )
    .reduce((sum, entry) => sum + entry.delta, 0);
}

export function recalculateGuestChances(
  guest: Guest,
  ledger: readonly LedgerEntry[]
): Guest {
  return { ...guest, chances: Math.max(0, getLedgerBalance(ledger, guest.id)) };
}

export function assertSeatChange(
  guests: readonly Guest[],
  tables: readonly EventTable[],
  change: { guestId: string; tableId: string | null; seat: number | null },
  mode: EventInfo["mode"] = "full"
): void {
  const guest = guests.find(candidate => candidate.id === change.guestId);
  if (!guest) fail(404, "GUEST_NOT_FOUND", "找不到嘉賓");
  if (isExcludedFromEvent({ mode }, guest))
    fail(409, "GUEST_EXCLUDED", "此紀錄保留但不參會，請先解除保留");

  if (change.tableId === null || change.seat === null) {
    if (change.tableId !== null || change.seat !== null) {
      fail(400, "INVALID_SEAT", "取消安排時枱號與座位必須同時留空");
    }
    return;
  }
  const table = tables.find(candidate => candidate.id === change.tableId);
  if (!table) fail(404, "TABLE_NOT_FOUND", "找不到圍枱");
  if (
    !Number.isInteger(change.seat) ||
    change.seat < 1 ||
    change.seat > 12 ||
    change.seat > table.capacity
  ) {
    fail(400, "INVALID_SEAT", "座位必須在該圍枱容量範圍內");
  }
  const occupied = guests.some(
    candidate =>
      candidate.id !== change.guestId &&
      !isExcludedFromEvent({ mode }, candidate) &&
      candidate.tableId === change.tableId &&
      candidate.seat === change.seat
  );
  if (occupied) fail(409, "SEAT_OCCUPIED", "此座位已被安排");
}

export type IdempotencyDecision = "new" | "replay";
export function idempotencyDecision(
  existingRequestHash: string | null,
  requestHash: string
): IdempotencyDecision {
  if (!existingRequestHash) return "new";
  if (existingRequestHash !== requestHash) {
    fail(409, "IDEMPOTENCY_MISMATCH", "相同冪等鍵不能用於不同請求");
  }
  return "replay";
}

export function activeRuleReceipts(
  receipts: readonly Receipt[],
  guestId: string,
  ruleVersion: number
): Receipt[] {
  return receipts.filter(
    receipt =>
      receipt.guestId === guestId &&
      receipt.status === "valid" &&
      receipt.ruleVersion === ruleVersion
  );
}

/**
 * Computes the ledger correction for a voided receipt.  It intentionally uses
 * that receipt's historical rule snapshot; newer event settings never alter it.
 */
export function voidLedgerAdjustment(
  receiptsAfterVoid: readonly Receipt[],
  ledger: readonly LedgerEntry[],
  guestId: string,
  receipt: Receipt
): number {
  const current = getLedgerBalance(ledger, guestId, receipt.ruleVersion);
  const valid = activeRuleReceipts(
    receiptsAfterVoid,
    guestId,
    receipt.ruleVersion
  );
  const desired =
    receipt.accumulation === "per_transaction"
      ? valid.reduce(
          (sum, item) =>
            sum + receiptChances(item.amountCents, item.thresholdCents),
          0
        )
      : Math.floor(
          valid.reduce((sum, item) => sum + item.amountCents, 0) /
            receipt.thresholdCents
        );
  return desired - current;
}

export function availableChances(
  aggregate: Pick<EventAggregate, "receipts" | "ledger">,
  guestId: string
): number {
  const groups = new Map<
    string,
    { amount: number; threshold: number; mode: Receipt["accumulation"] }
  >();
  let validChances = 0;
  for (const r of aggregate.receipts.filter(
    r => r.guestId === guestId && r.status === "valid"
  )) {
    if (r.accumulation === "per_transaction")
      validChances += receiptChances(r.amountCents, r.thresholdCents);
    else {
      const key = String(r.ruleVersion);
      const group = groups.get(key) || {
        amount: 0,
        threshold: r.thresholdCents,
        mode: r.accumulation,
      };
      group.amount += r.amountCents;
      groups.set(key, group);
    }
  }
  for (const group of groups.values())
    validChances += Math.floor(group.amount / group.threshold);
  return Math.max(
    0,
    Math.min(getLedgerBalance(aggregate.ledger, guestId), validChances)
  );
}

export function buildDrawSnapshot(
  aggregate: Pick<EventAggregate, "guests" | "ledger" | "receipts" | "draws">,
  excludeWinners: boolean
): DrawSnapshotEntry[] {
  const previousWinnerIds = new Set(
    aggregate.draws.map(draw => draw.winnerGuestId)
  );
  return aggregate.guests
    .map(guest => {
      const chances = availableChances(aggregate, guest.id);
      const validReceiptIds = new Set(
        aggregate.receipts
          .filter(
            receipt =>
              receipt.guestId === guest.id &&
              receipt.status === "valid" &&
              (receipt.accumulation === "cumulative" ||
                receiptChances(receipt.amountCents, receipt.thresholdCents) > 0)
          )
          .map(receipt => receipt.id)
      );
      const ledger = aggregate.ledger.filter(
        entry =>
          entry.guestId === guest.id &&
          entry.delta > 0 &&
          (entry.receiptId === null || validReceiptIds.has(entry.receiptId))
      );
      return {
        guestId: guest.id,
        ticket: guest.ticket,
        chances,
        ledgerIds: ledger.map(entry => entry.id),
        receiptIds: [...validReceiptIds],
      };
    })
    .filter(
      entry =>
        entry.chances > 0 &&
        (!excludeWinners || !previousWinnerIds.has(entry.guestId))
    );
}

export function selectWeightedWinner(
  snapshot: readonly DrawSnapshotEntry[],
  chooser: (maxExclusive: number) => number = max => randomInt(max)
): { winnerGuestId: string; totalChances: number; eligibleGuests: number } {
  const totalChances = snapshot.reduce((sum, entry) => sum + entry.chances, 0);
  if (!Number.isSafeInteger(totalChances) || totalChances <= 0) {
    fail(409, "NO_ELIGIBLE_CHANCES", "目前沒有可抽取的有效機會");
  }
  const selected = chooser(totalChances);
  if (!Number.isInteger(selected) || selected < 0 || selected >= totalChances) {
    fail(500, "RANDOM_FAILURE", "安全抽選程序失敗");
  }
  let cursor = selected;
  for (const entry of snapshot) {
    if (cursor < entry.chances) {
      return {
        winnerGuestId: entry.guestId,
        totalChances,
        eligibleGuests: snapshot.length,
      };
    }
    cursor -= entry.chances;
  }
  fail(500, "RANDOM_FAILURE", "安全抽選程序失敗");
}

export function receiptInAnyDrawSnapshot(
  receiptId: string,
  draws: readonly InternalDraw[]
): boolean {
  return draws.some(draw =>
    draw.snapshot.some(source => source.receiptIds.includes(receiptId))
  );
}

export function publicEventInfo(event: EventInfo): Omit<EventInfo, "tenantId"> {
  const { tenantId: _tenantId, ...safe } = event;
  return safe;
}
