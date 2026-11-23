import type {
  Connection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { POSITIVE_SPRING_EVENT_ID } from "../../shared/eventflow";
import type { EventAggregate } from "./engine";
import { EVENT_ID, ORGANIZATION_ID } from "./positive-spring-initializer";

export const CONSUMPTION_RULE_MARKER_KEY =
  "positive-spring-consumption-hkd500-cumulative-v1";
export const CONSUMPTION_RULE_ACTOR =
  "system:authorized-consumption-rule-migration";
export const CONSUMPTION_RULE_THRESHOLD_CENTS = 50_000;

export type ConsumptionRuleMode = "dry-run" | "apply";
export type ConsumptionRuleEventRow = {
  id: string;
  tenant_id: string;
  slug: string;
  owner_user_id: number | null;
  event_state: string;
};
// Database reads are scoped by event and organization and select event_state
// alone. Pure callers may additionally supply row identity for cross-checking.
type ConsumptionRuleStateRow = Pick<ConsumptionRuleEventRow, "event_state"> &
  Partial<Omit<ConsumptionRuleEventRow, "event_state">>;
export type ConsumptionRuleStatus =
  | "would_change"
  | "already_target"
  | "applied"
  | "already_applied";

/** Contains only explicitly permitted operational fields, never receipt data. */
export type ConsumptionRuleReport = {
  name: string;
  eventStatus: EventAggregate["event"]["status"];
  mode: ConsumptionRuleMode;
  status: ConsumptionRuleStatus;
  current: {
    thresholdCents: number;
    accumulation: EventAggregate["event"]["accumulation"];
  };
  projected: {
    thresholdCents: number;
    accumulation: EventAggregate["event"]["accumulation"];
  };
  receiptCount: number;
};
export type ConsumptionRulePlan = {
  aggregate: EventAggregate;
  /** True when event_state needs writing, including an audit-only marker. */
  changed: boolean;
  report: ConsumptionRuleReport;
};

export class ConsumptionRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsumptionRuleError";
  }
}

/** Raw driver errors may include SQL, hosts or credentials. Never expose them. */
export function safeConsumptionRuleError(error: unknown): ConsumptionRuleError {
  return error instanceof ConsumptionRuleError
    ? error
    : new ConsumptionRuleError(
        "消費規則更新未完成；請由授權操作員在安全環境檢查資料庫設定及衝突。"
      );
}

const AGGREGATE_ARRAYS = [
  "guests",
  "tables",
  "merchants",
  "receipts",
  "payments",
  "prizes",
  "draws",
  "ledger",
  "audit",
] as const satisfies readonly (keyof EventAggregate)[];
const AUDIT_MARKER_ID = `${CONSUMPTION_RULE_MARKER_KEY}:audit`;
const AUDIT_MARKER_ACTION = "event.consumption-rule.updated";

function readVerifiedAggregate(row: ConsumptionRuleStateRow): EventAggregate {
  let state: unknown;
  try {
    state = JSON.parse(row.event_state);
  } catch {
    throw new ConsumptionRuleError("活動資料格式不符；未作任何變更。");
  }
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    !("event" in state)
  ) {
    throw new ConsumptionRuleError("活動資料格式不符；未作任何變更。");
  }
  const aggregate = state as Record<string, unknown>;
  const event = aggregate.event;
  if (
    aggregate.version !== 1 ||
    !AGGREGATE_ARRAYS.every(field => Array.isArray(aggregate[field])) ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event)
  ) {
    throw new ConsumptionRuleError("活動資料結構不完整；未作任何變更。");
  }
  const info = event as Record<string, unknown>;
  if (
    POSITIVE_SPRING_EVENT_ID !== EVENT_ID ||
    (row.id !== undefined && row.id !== POSITIVE_SPRING_EVENT_ID) ||
    (row.tenant_id !== undefined && row.tenant_id !== ORGANIZATION_ID) ||
    info.id !== POSITIVE_SPRING_EVENT_ID ||
    info.tenantId !== ORGANIZATION_ID ||
    typeof info.slug !== "string" ||
    !info.slug ||
    (row.slug !== undefined && info.slug !== row.slug)
  ) {
    throw new ConsumptionRuleError("活動或組織識別碼不符；未作任何變更。");
  }
  if (
    typeof info.ruleVersion !== "number" ||
    !Number.isSafeInteger(info.ruleVersion) ||
    info.ruleVersion <= 0 ||
    typeof info.thresholdCents !== "number" ||
    !Number.isSafeInteger(info.thresholdCents) ||
    info.thresholdCents <= 0 ||
    (info.accumulation !== "per_transaction" &&
      info.accumulation !== "cumulative") ||
    typeof info.name !== "string" ||
    typeof info.status !== "string" ||
    !["draft", "live", "closed"].includes(info.status)
  ) {
    throw new ConsumptionRuleError("活動規則或版本不正確；請先人工審核。");
  }
  return state as EventAggregate;
}

/** Only the stable server-owned audit ID can prove migration completion. */
function hasVerifiedAuditMarker(aggregate: EventAggregate): boolean {
  const markers = aggregate.audit.filter(
    audit => audit && typeof audit === "object" && audit.id === AUDIT_MARKER_ID
  );
  if (markers.length > 1) {
    throw new ConsumptionRuleError("消費規則標記不唯一；未作任何變更。");
  }
  const marker = markers[0];
  if (!marker) return false;
  if (
    marker.actor !== CONSUMPTION_RULE_ACTOR ||
    marker.action !== AUDIT_MARKER_ACTION
  ) {
    throw new ConsumptionRuleError("消費規則標記身分不符；未作任何變更。");
  }
  // Our durable marker is always emitted with a canonical ISO UTC timestamp.
  if (
    typeof marker.createdAt !== "string" ||
    !Number.isFinite(Date.parse(marker.createdAt)) ||
    new Date(marker.createdAt).toISOString() !== marker.createdAt
  ) {
    throw new ConsumptionRuleError("消費規則標記日期不正確；未作任何變更。");
  }
  let detail: unknown;
  try {
    if (typeof marker.detail !== "string") throw new Error();
    detail = JSON.parse(marker.detail);
  } catch {
    throw new ConsumptionRuleError("消費規則標記資料不正確；未作任何變更。");
  }
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new ConsumptionRuleError("消費規則標記資料不正確；未作任何變更。");
  }
  const info = detail as Record<string, unknown>;
  if (
    info.markerKey !== CONSUMPTION_RULE_MARKER_KEY ||
    info.eventId !== POSITIVE_SPRING_EVENT_ID ||
    info.organizationId !== ORGANIZATION_ID
  ) {
    throw new ConsumptionRuleError("消費規則標記識別碼不符；未作任何變更。");
  }
  if (
    info.thresholdCents !== CONSUMPTION_RULE_THRESHOLD_CENTS ||
    info.accumulation !== "cumulative"
  ) {
    throw new ConsumptionRuleError("消費規則標記規則不正確；未作任何變更。");
  }
  return true;
}

/**
 * Pure planner: no database, clock, random IDs, or mutation of caller input.
 * Historical receipt rule snapshots, guests' balances, draws and ledger entries
 * are retained verbatim. Only the current event rule and one new audit change.
 * A verified aggregate audit marker takes precedence over later user changes;
 * there is deliberately no external marker input that can bypass validation.
 */
export function planPositiveSpringConsumptionRule(
  row: ConsumptionRuleStateRow,
  options: {
    mode: ConsumptionRuleMode;
    now: Date;
  }
): ConsumptionRulePlan {
  if (options.mode !== "dry-run" && options.mode !== "apply") {
    throw new ConsumptionRuleError("只允許 --dry-run 或 --apply。");
  }
  const aggregate = readVerifiedAggregate(row);
  const current = {
    thresholdCents: aggregate.event.thresholdCents,
    accumulation: aggregate.event.accumulation,
  };
  const report: ConsumptionRuleReport = {
    name: aggregate.event.name,
    eventStatus: aggregate.event.status,
    mode: options.mode,
    status: "already_applied",
    current,
    projected: { ...current },
    receiptCount: aggregate.receipts.length,
  };
  if (hasVerifiedAuditMarker(aggregate)) {
    return { aggregate, changed: false, report };
  }

  const alreadyTarget =
    current.thresholdCents === CONSUMPTION_RULE_THRESHOLD_CENTS &&
    current.accumulation === "cumulative";
  const knownBaseline =
    current.thresholdCents === 100_000 &&
    current.accumulation === "per_transaction";
  if (!alreadyTarget && !knownBaseline) {
    throw new ConsumptionRuleError(
      "現有消費規則不是已知原設定或目標設定；請先人工審核，不會覆寫使用者設定。"
    );
  }
  report.projected = {
    thresholdCents: CONSUMPTION_RULE_THRESHOLD_CENTS,
    accumulation: "cumulative",
  };
  report.status = alreadyTarget ? "already_target" : "would_change";
  if (
    !alreadyTarget &&
    aggregate.event.ruleVersion === Number.MAX_SAFE_INTEGER
  ) {
    throw new ConsumptionRuleError("規則版本無法安全遞增；請先人工審核。");
  }
  if (!Number.isFinite(options.now.getTime())) {
    throw new ConsumptionRuleError("操作日期不正確；未作任何變更。");
  }
  const createdAt = options.now.toISOString();
  const ruleVersion = aggregate.event.ruleVersion + (alreadyTarget ? 0 : 1);
  const projected: EventAggregate = {
    ...aggregate,
    event: alreadyTarget
      ? aggregate.event
      : {
          ...aggregate.event,
          thresholdCents: CONSUMPTION_RULE_THRESHOLD_CENTS,
          accumulation: "cumulative",
          ruleVersion,
        },
    audit: [
      ...aggregate.audit,
      {
        id: AUDIT_MARKER_ID,
        actor: CONSUMPTION_RULE_ACTOR,
        action: AUDIT_MARKER_ACTION,
        createdAt,
        detail: JSON.stringify({
          markerKey: CONSUMPTION_RULE_MARKER_KEY,
          eventId: POSITIVE_SPRING_EVENT_ID,
          organizationId: ORGANIZATION_ID,
          thresholdCents: CONSUMPTION_RULE_THRESHOLD_CENTS,
          accumulation: "cumulative",
          ruleVersion,
          changedAt: createdAt,
        }),
      },
    ],
  };
  return { aggregate: projected, changed: true, report };
}

/**
 * Caller owns/closes the connection. Default dry-run selects event_state only:
 * no BEGIN, locks, session SET, DDL, DML, or other write-side effects.
 * Apply serializes on the actual event row. The rule and durable audit marker
 * are written atomically in the same event_state update, even if already target.
 * Initialization markers, timestamps, ownership and historical tables are never
 * read or written by this migration.
 */
export async function setPositiveSpringConsumptionRule(
  connection: Connection,
  options: { mode?: ConsumptionRuleMode; now?: Date } = {}
): Promise<ConsumptionRuleReport> {
  const mode = options.mode ?? "dry-run";
  if (mode !== "dry-run" && mode !== "apply") {
    throw new ConsumptionRuleError("只允許 --dry-run 或 --apply。");
  }
  const now = options.now ?? new Date();
  let inTransaction = false;
  try {
    if (mode === "apply") {
      await connection.beginTransaction();
      inTransaction = true;
    }
    // No owner predicate: the initialized event may legitimately be unowned.
    const [events] = await connection.execute<
      (RowDataPacket & Pick<ConsumptionRuleEventRow, "event_state">)[]
    >(
      "SELECT event_state FROM ef_events WHERE id = ? AND tenant_id = ?" +
        (mode === "apply" ? " FOR UPDATE" : ""),
      [POSITIVE_SPRING_EVENT_ID, ORGANIZATION_ID]
    );
    if (events.length !== 1) {
      throw new ConsumptionRuleError("找不到唯一的指定活動；未作任何變更。");
    }
    const plan = planPositiveSpringConsumptionRule(events[0]!, { mode, now });
    if (mode === "dry-run") return plan.report;

    if (plan.changed) {
      // No timestamp, slug, ownership, organization, or historical-table edits.
      const [updated] = await connection.execute<ResultSetHeader>(
        "UPDATE ef_events SET event_state = ? WHERE id = ? AND tenant_id = ?",
        [
          JSON.stringify(plan.aggregate),
          POSITIVE_SPRING_EVENT_ID,
          ORGANIZATION_ID,
        ]
      );
      if (updated.affectedRows !== 1) {
        throw new ConsumptionRuleError("活動更新筆數不正確；未提交任何變更。");
      }
      plan.report.status = "applied";
    }
    await connection.commit();
    inTransaction = false;
    return plan.report;
  } catch (error) {
    if (inTransaction) {
      try {
        await connection.rollback();
      } catch {
        // Preserve the safe original failure. Caller must always close connection.
      }
    }
    throw safeConsumptionRuleError(error);
  }
}
