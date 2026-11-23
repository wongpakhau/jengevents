import { randomUUID } from "node:crypto";
import type { ClaimResult, Guest, Receipt } from "../../shared/eventflow";
import {
  DomainError,
  assertEventScope,
  availableChances,
  cumulativeClaimDelta,
  receiptChances,
  recalculateGuestChances,
  type EventAggregate,
} from "./engine";

/** Shared by explicit legacy claims and guest-bound confirmations. */
export function applyReceiptClaim(
  aggregate: EventAggregate,
  receipt: Receipt,
  guest: Guest,
  now: Date
): ClaimResult {
  const prior = aggregate.receipts
    .filter(
      item =>
        item.id !== receipt.id &&
        item.guestId === guest.id &&
        item.status === "valid" &&
        item.ruleVersion === receipt.ruleVersion
    )
    .reduce((sum, item) => sum + item.amountCents, 0);
  const gained =
    receipt.accumulation === "per_transaction"
      ? receiptChances(receipt.amountCents, receipt.thresholdCents)
      : cumulativeClaimDelta(
          prior,
          receipt.amountCents,
          receipt.thresholdCents
        );
  const claimed: Receipt = {
    ...receipt,
    status: "valid",
    guestId: guest.id,
    claimedAt: now.toISOString(),
    chances: gained,
    ...(receipt.confirmationRequired ? { decisionAt: now.toISOString() } : {}),
  };
  aggregate.receipts[
    aggregate.receipts.findIndex(item => item.id === receipt.id)
  ] = claimed;
  if (gained)
    aggregate.ledger.push({
      id: randomUUID(),
      guestId: guest.id,
      receiptId: receipt.id,
      ruleVersion: receipt.ruleVersion,
      delta: gained,
      kind: "claim",
      createdAt: now.toISOString(),
    });
  const guestIndex = aggregate.guests.findIndex(item => item.id === guest.id);
  aggregate.guests[guestIndex] = recalculateGuestChances(
    guest,
    aggregate.ledger
  );
  return {
    receipt: claimed,
    gained,
    total: availableChances(aggregate, guest.id),
    alreadyClaimed: false,
  };
}

/** Validate even before an idempotent replay, so voids/expiry cannot return a stale success. */
export function assertReceiptDecision(
  aggregate: EventAggregate,
  receipt: Receipt,
  guest: Guest,
  confirmed: boolean,
  now: Date
): void {
  assertEventScope(aggregate.event.id, receipt.eventId);
  if (receipt.status === "void")
    throw new DomainError(409, "RECEIPT_VOID", "此消費憑證已作廢");
  if (
    !receipt.confirmationRequired ||
    receipt.intendedGuestId !== guest.id ||
    (receipt.guestId !== null && receipt.guestId !== guest.id)
  )
    throw new DomainError(403, "RECEIPT_GUEST_SCOPE", "此消費憑證不屬於你");
  if (
    !Number.isFinite(Date.parse(receipt.expiresAt)) ||
    Date.parse(receipt.expiresAt) <= now.getTime()
  )
    throw new DomainError(410, "RECEIPT_EXPIRED", "消費憑證已過期");
  if (receipt.status === "pending") {
    if (
      receipt.guestId !== null ||
      receipt.claimedAt ||
      receipt.decisionAt ||
      receipt.chances !== 0
    )
      throw new DomainError(409, "RECEIPT_STATE_INVALID", "消費憑證狀態不正確");
    return;
  }
  if (
    (confirmed &&
      receipt.status === "valid" &&
      receipt.guestId === guest.id &&
      receipt.claimedAt &&
      receipt.decisionAt) ||
    (!confirmed &&
      receipt.status === "rejected" &&
      receipt.guestId === null &&
      receipt.decisionAt)
  )
    return;
  throw new DomainError(
    409,
    "RECEIPT_DECISION_CONFLICT",
    "此消費憑證已有不同確認結果，不可更改"
  );
}

export function decideReceipt(
  aggregate: EventAggregate,
  receipt: Receipt,
  guest: Guest,
  confirmed: boolean,
  now: Date
): ClaimResult {
  assertReceiptDecision(aggregate, receipt, guest, confirmed, now);
  if (receipt.status !== "pending")
    return {
      receipt,
      gained: 0,
      total: availableChances(aggregate, guest.id),
      alreadyClaimed: true,
    };
  if (confirmed) return applyReceiptClaim(aggregate, receipt, guest, now);
  const rejected: Receipt = {
    ...receipt,
    status: "rejected",
    decisionAt: now.toISOString(),
    chances: 0,
  };
  aggregate.receipts[
    aggregate.receipts.findIndex(item => item.id === receipt.id)
  ] = rejected;
  return {
    receipt: rejected,
    gained: 0,
    total: availableChances(aggregate, guest.id),
    alreadyClaimed: false,
  };
}
