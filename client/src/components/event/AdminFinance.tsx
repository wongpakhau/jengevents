import { useEffect, useMemo, useState } from "react";
import { Download, Landmark, Plus, ReceiptText, X } from "lucide-react";
import type { Receipt, Settlement } from "@shared/eventflow";
import { PageHeading } from "@/components/event/EventShell";
import { api, apiFetch, money } from "@/lib/eventflow-api";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { formatIso, hasRole, InlineError, managerRoles, parseCents, RoleNotice, useWorkspaceMutation } from "./AdminShared";

type PaymentDraft = { merchantId: string; amount: string; reference: string };
const blankPayment: PaymentDraft = { merchantId: "", amount: "", reference: "" };

export default function AdminFinance() {
  const { state, eventId } = useWorkspace();
  const { mutate, isPending, errorFor } = useWorkspaceMutation();
  const [settlements, setSettlements] = useState<Settlement[] | null>(null);
  const [settlementsError, setSettlementsError] = useState<string | null>(null);
  const [loadingSettlements, setLoadingSettlements] = useState(false);
  const [payment, setPayment] = useState<PaymentDraft>(blankPayment);
  const [showPayment, setShowPayment] = useState(false);
  const [paymentValidation, setPaymentValidation] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<Receipt | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidValidation, setVoidValidation] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const canManage = state ? hasRole(state.role, managerRoles) : false;

  useEffect(() => {
    if (!state || !canManage) { setSettlements(null); return; }
    let cancelled = false;
    setLoadingSettlements(true);
    setSettlementsError(null);
    void api<Settlement[]>(`/events/${eventId}/settlements`).then(result => {
      if (!cancelled) setSettlements(result);
    }).catch(error => {
      if (!cancelled) setSettlementsError(error instanceof Error ? error.message : "未能讀取商戶對帳資料。");
    }).finally(() => { if (!cancelled) setLoadingSettlements(false); });
    return () => { cancelled = true; };
  }, [canManage, eventId, state?.receipts, state?.payments]);

  if (!state) return null;
  const validReceipts = state.receipts.filter(receipt => receipt.status === "valid");
  const salesCents = validReceipts.reduce((total, receipt) => total + receipt.amountCents, 0);
  const dueCents = validReceipts.reduce((total, receipt) => total + receipt.feeCents, 0);
  const paidCents = state.payments.reduce((total, paymentItem) => total + paymentItem.amountCents, 0);

  const merchantNames = useMemo(() => new Map(state.merchants.map(merchant => [merchant.id, merchant.name])), [state.merchants]);
  const submitPayment = async (event: React.FormEvent) => {
    event.preventDefault();
    const amountCents = parseCents(payment.amount);
    if (!payment.merchantId || amountCents === null || amountCents <= 0 || !payment.reference.trim()) {
      setPaymentValidation("請選擇商戶，填寫正數金額及對帳參考編號。");
      return;
    }
    setPaymentValidation(null);
    const result = await mutate("payment-create", `/events/${eventId}/payments`, "POST", { merchantId: payment.merchantId, amountCents, reference: payment.reference.trim() });
    if (result) { setShowPayment(false); setPayment(blankPayment); }
  };
  const submitVoid = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!voiding || !voidReason.trim()) { setVoidValidation("請填寫作廢原因，以保留稽核紀錄。"); return; }
    setVoidValidation(null);
    const result = await mutate(`receipt-void-${voiding.id}`, `/events/${eventId}/receipts/${voiding.id}/void`, "POST", { reason: voidReason.trim() });
    if (result) { setVoiding(null); setVoidReason(""); }
  };
  const exportCsv = async () => {
    setExportError(null);
    setExporting(true);
    try {
      const response = await apiFetch(`/events/${encodeURIComponent(eventId)}/export`, { headers: { Accept: "text/csv" } });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "CSV 匯出未能完成。");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const matched = disposition.match(/filename=?\"?([^\";]+)\"?/i);
      const anchor = document.createElement("a");
      const url = URL.createObjectURL(blob);
      anchor.href = url;
      anchor.download = matched?.[1] || "eventflow-settlements.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "CSV 匯出未能完成。");
    } finally { setExporting(false); }
  };

  return <>
    <PageHeading eyebrow="EVERY TRANSACTION, ACCOUNTED FOR" title="交易與對帳" description="有效消費逐筆帶出抽獎費；手動收款只作記錄，不會自動扣款。" action={canManage ? <><button className="button button-white" disabled={exporting} onClick={() => void exportCsv()}><Download size={15} />{exporting ? "匯出中…" : "CSV 匯出"}</button><button className="button button-dark" onClick={() => setShowPayment(true)}><Plus size={16} />登記已收款</button></> : undefined} />
    <RoleNotice allowed={managerRoles}>只有擁有者或管理員可存取完整對帳、作廢交易、登記收款及下載 CSV。商戶可見的資料由伺服器限制在其授權範圍。</RoleNotice>
    <InlineError message={exportError ?? undefined} />

    <section className="mvp-finance-summary">
      <article className="mvp-panel"><span>有效消費</span><strong>{money(salesCents)}</strong><small>{validReceipts.length} 筆有效憑證</small></article>
      <article className="mvp-panel"><span>10% 應收抽獎費</span><strong>{money(dueCents)}</strong><small>逐筆按伺服器費用快照</small></article>
      <article className="mvp-panel"><span>已收款</span><strong>{money(paidCents)}</strong><small>手動登記，非自動扣款</small></article>
      <article className="mvp-panel"><span>尚餘</span><strong>{money(dueCents - paidCents)}</strong><small>應收減已收</small></article>
    </section>

    {canManage && <section className="mvp-panel mvp-settlement-panel"><div className="mvp-panel-heading"><div><span className="mvp-kicker">MERCHANT SETTLEMENTS</span><h2>商戶對帳</h2></div></div>{loadingSettlements && <div className="mvp-empty compact"><p>正在讀取伺服器對帳資料…</p></div>}{settlementsError && <InlineError message={settlementsError} />}{settlements && <div className="mvp-data-table"><div className="mvp-table-head"><span>商戶</span><span>有效消費</span><span>應收 10%</span><span>已收</span><span>餘額</span></div>{settlements.map(item => <div className="mvp-table-row" key={item.merchant.id}><strong>{item.merchant.name}</strong><span>{money(item.salesCents)}</span><span>{money(item.dueCents)}</span><span>{money(item.paidCents)}</span><strong className={item.balanceCents > 0 ? "mvp-amount-due" : ""}>{money(item.balanceCents)}</strong></div>)}{!settlements.length && <div className="mvp-empty compact"><p>尚未有商戶對帳資料。</p></div>}</div>}</section>}

    <section className="mvp-panel mvp-receipt-panel"><div className="mvp-panel-heading"><div><span className="mvp-kicker">RECEIPTS</span><h2>消費憑證</h2></div></div><div className="mvp-data-table mvp-receipts-table"><div className="mvp-table-head"><span>商戶／參考編號</span><span>消費</span><span>抽獎費</span><span>狀態</span><span>建立時間</span><span>操作</span></div>{state.receipts.map(receipt => <div className="mvp-table-row" key={receipt.id}><div><strong>{merchantNames.get(receipt.merchantId) || "已移除商戶"}</strong><small>{receipt.reference}</small></div><span>{money(receipt.amountCents)}</span><span>{money(receipt.feeCents)}</span><div><span className={`mvp-status ${receipt.status === "valid" ? "success" : "danger"}`}>{receipt.status === "valid" ? "有效" : "已作廢"}</span>{receipt.voidReason && <small className="mvp-void-reason">原因：{receipt.voidReason}</small>}</div><small>{formatIso(receipt.createdAt)}</small><div>{canManage && receipt.status === "valid" && <button className="mvp-text-button danger" onClick={() => { setVoiding(receipt); setVoidReason(""); setVoidValidation(null); }}><ReceiptText size={14} />作廢</button>}{receipt.drawException && <small className="mvp-draw-exception">已被抽獎快照引用</small>}</div></div>)}{!state.receipts.length && <div className="mvp-empty compact"><p>目前沒有消費憑證。</p></div>}</div></section>

    {showPayment && <div className="mvp-dialog-backdrop" role="presentation"><section className="mvp-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-title"><button className="mvp-dialog-close" aria-label="關閉" onClick={() => setShowPayment(false)}><X size={18} /></button><span className="mvp-kicker">MANUAL PAYMENT RECORD</span><h2 id="payment-title">登記已收款</h2><p className="mvp-dialog-copy"><Landmark size={15} />只建立對帳記錄，不會連接或執行任何自動扣款。</p><form className="mvp-form" onSubmit={submitPayment}><label>商戶<select required value={payment.merchantId} onChange={event => setPayment(current => ({ ...current, merchantId: event.target.value }))}><option value="">選擇商戶</option>{state.merchants.map(merchant => <option key={merchant.id} value={merchant.id}>{merchant.name}{merchant.active ? "" : "（已停用）"}</option>)}</select></label><label>已收金額（HK$）<input required inputMode="decimal" value={payment.amount} onChange={event => setPayment(current => ({ ...current, amount: event.target.value }))} placeholder="例如 250.00" /></label><label>對帳參考編號<input required value={payment.reference} onChange={event => setPayment(current => ({ ...current, reference: event.target.value }))} placeholder="例如 BANK-20261030-01" /></label><InlineError message={paymentValidation || errorFor("payment-create")} /><div className="mvp-dialog-actions"><button type="button" className="button button-white" onClick={() => setShowPayment(false)}>取消</button><button className="button button-dark" disabled={isPending("payment-create")}>{isPending("payment-create") ? "登記中…" : "登記收款"}</button></div></form></section></div>}

    {voiding && <div className="mvp-dialog-backdrop" role="presentation"><section className="mvp-dialog" role="dialog" aria-modal="true" aria-labelledby="void-title"><button className="mvp-dialog-close" aria-label="關閉" onClick={() => setVoiding(null)}><X size={18} /></button><span className="mvp-kicker">VOID RECEIPT</span><h2 id="void-title">作廢此消費憑證？</h2><p className="mvp-dialog-copy">作廢會保留稽核紀錄；若憑證已被抽獎快照引用，伺服器會標記例外而不靜默改寫結果。</p><form className="mvp-form" onSubmit={submitVoid}><label>作廢原因<textarea required value={voidReason} onChange={event => setVoidReason(event.target.value)} placeholder="請說明作廢原因" /></label><InlineError message={voidValidation || errorFor(`receipt-void-${voiding.id}`)} /><div className="mvp-dialog-actions"><button type="button" className="button button-white" onClick={() => setVoiding(null)}>取消</button><button className="button mvp-button-danger" disabled={isPending(`receipt-void-${voiding.id}`)}>{isPending(`receipt-void-${voiding.id}`) ? "作廢中…" : "確認作廢"}</button></div></form></section></div>}
  </>;
}
