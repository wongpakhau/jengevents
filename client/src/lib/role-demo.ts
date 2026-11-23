/** Front-end demonstration only. These role checks are NOT authentication. */
export const ROLE_DEMO_STORAGE_KEY = "eventflow.role-demo.v1";
export const DEMO_GUEST_QR = "eventflow-demo:guest:demo-guest";
export const DEMO_GUEST = Object.freeze({
  id: "demo-guest",
  name: "示範用家",
  checkedIn: true,
});
export const DEMO_MERCHANT = Object.freeze({
  id: "demo-merchant",
  name: "示範商戶・好物小店",
});
export const DEMO_SPEND_PER_CHANCE_CENTS = 50_000;
export const DEMO_CHECKED_IN_PRIZE_CENTS = 100_000;

export type DemoRole = "admin" | "merchant" | "guest";
export type DemoReceiptStatus = "pending" | "confirmed" | "rejected";
export type DemoReceipt = {
  id: string;
  guestId: typeof DEMO_GUEST.id;
  merchantId: typeof DEMO_MERCHANT.id;
  amountCents: number;
  reference: string;
  status: DemoReceiptStatus;
  createdAt: string;
  decidedAt?: string;
};
export type RoleDemoState = {
  version: 1;
  revision: number;
  nextReceiptNumber: number;
  receipts: DemoReceipt[];
};
export type RoleDemoAction =
  | {
      type: "submit";
      guestCode: string;
      amount: string;
      reference: string;
      at: string;
    }
  | { type: "confirm" | "reject"; receiptId: string; at: string }
  | { type: "reset" };

export class RoleDemoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleDemoError";
  }
}

export function createRoleDemoState(): RoleDemoState {
  return { version: 1, revision: 0, nextReceiptNumber: 1, receipts: [] };
}

/** Exact demo namespace only; real tokens, URLs and other guest codes are refused. */
export function isDemoGuestCode(value: string): boolean {
  return value === DEMO_GUEST_QR;
}

/** Decimal-string conversion avoids binary floating-point rounding of user input. */
export function parseDemoAmountCents(value: string): number | null {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function referenceKey(value: string) {
  return value.trim().toUpperCase();
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function requireDemoRole(actual: DemoRole, required: DemoRole) {
  if (actual !== required) {
    throw new RoleDemoError(
      "此示範角色沒有執行這項操作的權限；這不是正式登入權限。"
    );
  }
}

/** Immutable demo transitions. The caller supplies time; no I/O or production dependencies. */
export function applyRoleDemoAction(
  state: RoleDemoState,
  role: DemoRole,
  action: RoleDemoAction
): RoleDemoState {
  if (!Number.isSafeInteger(state.revision + 1)) {
    throw new RoleDemoError("示範資料已超出安全數值範圍。");
  }
  if (action.type === "reset") {
    requireDemoRole(role, "admin");
    return { ...createRoleDemoState(), revision: state.revision + 1 };
  }
  if (action.type === "submit") {
    requireDemoRole(role, "merchant");
    if (!isDemoGuestCode(action.guestCode)) {
      throw new RoleDemoError(
        "只接受示範用家的 DEMO QR；正式 QR、網址及其他代碼均不可使用。"
      );
    }
    const amountCents = parseDemoAmountCents(action.amount);
    if (amountCents === null) {
      throw new RoleDemoError(
        "請輸入大於 HK$0 的金額，最多兩位小數，不接受逗號或科學記號。"
      );
    }
    const reference = action.reference.trim();
    if (!reference || reference.length > 80) {
      throw new RoleDemoError("請輸入 1–80 字的商戶交易參考編號。");
    }
    if (
      state.receipts.some(
        receipt => referenceKey(receipt.reference) === referenceKey(reference)
      )
    ) {
      throw new RoleDemoError(
        "此參考編號已存在，不能重複建立示範交易（包括已拒絕交易）。"
      );
    }
    const totalCents = state.receipts.reduce(
      (sum, receipt) => sum + receipt.amountCents,
      0
    );
    if (
      !Number.isSafeInteger(totalCents + amountCents) ||
      !Number.isSafeInteger(state.nextReceiptNumber + 1)
    ) {
      throw new RoleDemoError("示範交易金額已超出安全數值範圍。");
    }
    if (!isTimestamp(action.at)) throw new RoleDemoError("示範交易時間無效。");
    const receipt: DemoReceipt = {
      id: `demo-receipt-${state.nextReceiptNumber}`,
      guestId: DEMO_GUEST.id,
      merchantId: DEMO_MERCHANT.id,
      amountCents,
      reference,
      status: "pending",
      createdAt: action.at,
    };
    return {
      ...state,
      revision: state.revision + 1,
      nextReceiptNumber: state.nextReceiptNumber + 1,
      receipts: [...state.receipts, receipt],
    };
  }
  if (action.type !== "confirm" && action.type !== "reject") {
    throw new RoleDemoError("不支援的示範操作。");
  }
  requireDemoRole(role, "guest");
  const receipt = state.receipts.find(item => item.id === action.receiptId);
  if (!receipt || receipt.guestId !== DEMO_GUEST.id) {
    throw new RoleDemoError("找不到屬於示範用家的交易。");
  }
  if (receipt.status !== "pending") {
    throw new RoleDemoError("此交易已處理，不能重複確認或更改決定。");
  }
  if (!isTimestamp(action.at)) throw new RoleDemoError("示範確認時間無效。");
  return {
    ...state,
    revision: state.revision + 1,
    receipts: state.receipts.map(item =>
      item.id === receipt.id
        ? {
            ...item,
            status: action.type === "confirm" ? "confirmed" : "rejected",
            decidedAt: action.at,
          }
        : item
    ),
  };
}

export function getDemoSummary(state: RoleDemoState) {
  const confirmed = state.receipts.filter(
    receipt => receipt.status === "confirmed"
  );
  const confirmedSpendCents = confirmed.reduce(
    (sum, receipt) => sum + receipt.amountCents,
    0
  );
  return {
    confirmedSpendCents,
    spendChances: Math.floor(confirmedSpendCents / DEMO_SPEND_PER_CHANCE_CENTS),
    remainderCents: confirmedSpendCents % DEMO_SPEND_PER_CHANCE_CENTS,
    untilNextChanceCents:
      DEMO_SPEND_PER_CHANCE_CENTS -
      (confirmedSpendCents % DEMO_SPEND_PER_CHANCE_CENTS),
    // Demo manual settlement only; round 10% of the total to the nearest cent.
    manualDueCents: Math.round(confirmedSpendCents / 10),
    checkedInChances: DEMO_GUEST.checkedIn ? 1 : 0,
    confirmedCount: confirmed.length,
    pendingCount: state.receipts.filter(receipt => receipt.status === "pending")
      .length,
    rejectedCount: state.receipts.filter(
      receipt => receipt.status === "rejected"
    ).length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly rebuild the one-fixture schema, never load arbitrary guests or merchants. */
export function parseRoleDemoState(raw: string | null): RoleDemoState {
  if (raw === null) return createRoleDemoState();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RoleDemoError("本機示範資料無效；請由示範管理員重設。");
  }
  const invalid = () =>
    new RoleDemoError("本機示範資料格式不符；請由示範管理員重設。");
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.nextReceiptNumber) ||
    (value.nextReceiptNumber as number) < 1 ||
    !Array.isArray(value.receipts)
  )
    throw invalid();
  const ids = new Set<string>();
  const references = new Set<string>();
  let totalCents = 0;
  const receipts = value.receipts.map((entry: unknown): DemoReceipt => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !/^demo-receipt-[1-9]\d*$/.test(entry.id) ||
      entry.guestId !== DEMO_GUEST.id ||
      entry.merchantId !== DEMO_MERCHANT.id ||
      !Number.isSafeInteger(entry.amountCents) ||
      (entry.amountCents as number) <= 0 ||
      typeof entry.reference !== "string" ||
      !entry.reference.trim() ||
      entry.reference.length > 80 ||
      !["pending", "confirmed", "rejected"].includes(entry.status as string) ||
      !isTimestamp(entry.createdAt) ||
      (entry.status === "pending"
        ? entry.decidedAt !== undefined
        : !isTimestamp(entry.decidedAt))
    )
      throw invalid();
    const number = Number(entry.id.slice("demo-receipt-".length));
    if (
      !Number.isSafeInteger(number) ||
      number >= (value.nextReceiptNumber as number) ||
      ids.has(entry.id) ||
      references.has(referenceKey(entry.reference))
    )
      throw invalid();
    totalCents += entry.amountCents as number;
    if (!Number.isSafeInteger(totalCents)) throw invalid();
    ids.add(entry.id);
    references.add(referenceKey(entry.reference));
    return {
      id: entry.id,
      guestId: DEMO_GUEST.id,
      merchantId: DEMO_MERCHANT.id,
      amountCents: entry.amountCents as number,
      reference: entry.reference.trim(),
      status: entry.status as DemoReceiptStatus,
      createdAt: entry.createdAt,
      ...(entry.decidedAt === undefined
        ? {}
        : { decidedAt: entry.decidedAt as string }),
    };
  });
  return {
    version: 1,
    revision: value.revision as number,
    nextReceiptNumber: value.nextReceiptNumber as number,
    receipts,
  };
}

export function serializeRoleDemoState(state: RoleDemoState): string {
  return JSON.stringify(parseRoleDemoState(JSON.stringify(state)));
}
