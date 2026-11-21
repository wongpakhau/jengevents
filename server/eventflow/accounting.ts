import type { Merchant, Receipt, Payment } from "../../shared/eventflow";
export function merchantSettlement(
  merchant: Merchant,
  receipts: Receipt[],
  payments: Payment[]
) {
  const valid = receipts.filter(
    r => r.merchantId === merchant.id && r.status === "valid"
  );
  const own = payments.filter(p => p.merchantId === merchant.id);
  const salesCents = valid.reduce((n, r) => n + r.amountCents, 0),
    dueCents = valid.reduce((n, r) => n + r.feeCents, 0),
    paidCents = own.reduce((n, p) => n + p.amountCents, 0);
  return {
    merchant,
    salesCents,
    dueCents,
    paidCents,
    balanceCents: dueCents - paidCents,
  };
}
function cell(value: string | number) {
  let s = String(value);
  if (
    typeof value === "string" &&
    (/^[\s]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s))
  )
    s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export function accountingCsv(
  merchants: Merchant[],
  receipts: Receipt[],
  payments: Payment[]
) {
  const names = new Map(merchants.map(m => [m.id, m.name]));
  const rows: (string | number)[][] = [
    [
      "記錄類型",
      "時間",
      "商戶",
      "參考",
      "原交易金額(分)",
      "有效銷售(分)",
      "原抽獎費(分)",
      "作廢費用調整(分)",
      "有效應收(分)",
      "狀態",
      "已領取",
      "作廢原因",
      "已收款(分)",
    ],
  ];
  for (const r of receipts)
    rows.push([
      "交易",
      r.createdAt,
      names.get(r.merchantId) || "",
      r.reference,
      r.amountCents,
      r.status === "valid" ? r.amountCents : 0,
      r.feeCents,
      r.status === "void" ? -r.feeCents : 0,
      r.status === "valid" ? r.feeCents : 0,
      r.status,
      r.claimedAt ? "是" : "否",
      r.voidReason || "",
      0,
    ]);
  for (const p of payments)
    rows.push([
      "收款",
      p.createdAt,
      names.get(p.merchantId) || "",
      p.reference,
      0,
      0,
      0,
      0,
      0,
      "recorded",
      "",
      "",
      p.amountCents,
    ]);
  return "\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n");
}
