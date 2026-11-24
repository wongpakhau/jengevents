import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Package,
  ReceiptText,
  RefreshCw,
  ScanLine,
  Store,
  Ticket,
} from "lucide-react";
import { api, idempotencyKey, money } from "@/lib/eventflow-api";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { stateScopeKey } from "@/lib/workspace-scope";
import { roleHome, roleHomeLabel } from "@/lib/role-home";
import QRScanner from "@/components/event/QRScanner";
import QRCode from "@/components/event/QRCode";
import { PreorderList } from "@/components/event/ConsumerTickets";
import { purchaseCodeFromQr } from "@/lib/purchase-qr";
import { memberCodeFromQr } from "@/lib/member-qr";
import type {
  Preorder,
  PurchaseCodeResolved,
  ReceiptIssued,
} from "@shared/eventflow";
import "@/styles/event-mobile.css";
import "@/styles/role-entry.css";
import "@/styles/member-commerce.css";

const amountPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
function toCents(value: string) {
  if (!amountPattern.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000
    ? cents
    : null;
}
function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "操作未完成，請以相同資料重試。";
}
function expiryLabel(value: string) {
  return new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value));
}
/** Device-generated reference when the merchant has no POS slip number to copy. */
function autoReference(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .toUpperCase()
    .padStart(3, "0");
  return `AUTO-${stamp}-${suffix}`;
}
function MerchantSteps({ step }: { step: 1 | 2 | 3 }) {
  const labels = ["掃會員碼", "輸入金額", "等買家確認"];
  return (
    <ol className="merchant-steps" aria-label="開單步驟">
      {labels.map((label, index) => {
        const number = index + 1;
        const className =
          number === step ? "is-active" : number < step ? "is-done" : "";
        return (
          <li
            key={label}
            className={className}
            aria-current={number === step ? "step" : undefined}
          >
            {label}
          </li>
        );
      })}
    </ol>
  );
}
type PurchaseGuest = PurchaseCodeResolved;

export default function MerchantTerminal() {
  const { state, eventId } = useWorkspace();
  return <MerchantTerminalForScope key={stateScopeKey(eventId, state)} />;
}
function MerchantTerminalForScope() {
  const {
    session,
    state,
    loading,
    error: workspaceError,
    reload,
    lastUpdatedAt,
  } = useWorkspace();
  const [merchantId, setMerchantId] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [issued, setIssued] = useState<ReceiptIssued | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The scanner panel is open from the start; the camera itself still waits for a tap.
  const [scanning, setScanning] = useState(true);
  const [scanBusy, setScanBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [purchaseCode, setPurchaseCode] = useState("");
  const [purchaseGuest, setPurchaseGuest] = useState<PurchaseGuest | null>(
    null
  );
  const [preorderBusy, setPreorderBusy] = useState<string | null>(null);
  const [preorderNotice, setPreorderNotice] = useState("");
  const [newPreorderItem, setNewPreorderItem] = useState("");
  const [newPreorderQty, setNewPreorderQty] = useState("1");
  const [showPreorderForm, setShowPreorderForm] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const receiptKeyRef = useRef(idempotencyKey());
  const lastAttemptSignatureRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const active = useRef(true);
  const selectionRef = useRef(merchantId);
  selectionRef.current = merchantId;
  const merchants = state?.merchants ?? [];
  const event = state?.event;
  const selectedMerchant =
    merchants.find(merchant => merchant.id === merchantId) ?? null;
  const amountCents = toCents(amount);
  const roleAllowed =
    state &&
    ["owner", "admin", "project_manager", "merchant"].includes(state.role);
  const staffWorkspace =
    state && ["owner", "admin", "project_manager"].includes(state.role);

  useEffect(() => {
    active.current = true;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => {
      active.current = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!merchants.length) {
      setMerchantId("");
      return;
    }
    if (!merchants.some(merchant => merchant.id === merchantId))
      setMerchantId(
        merchants.find(merchant => merchant.active)?.id ?? merchants[0].id
      );
  }, [merchantId, merchants]);

  const resolveCode = async (raw: string) => {
    // Membership QR (or a typed member code) is the primary path; the
    // one-time purchase QR remains accepted as a fallback.
    const oneTime = purchaseCodeFromQr(raw, window.location.origin);
    const member = oneTime
      ? null
      : memberCodeFromQr(raw, window.location.origin);
    if (!oneTime && !member)
      throw new Error(
        "請掃描用戶嘉賓頁的會員 QR，或直接輸入會員碼；邀請或登入 QR 不適用。"
      );
    if (!state || !selectedMerchant?.active || busyRef.current)
      throw new Error("請先選擇授權且啟用中的商戶。");
    busyRef.current = true;
    setScanBusy(true);
    setFormError(null);
    setPreorderNotice("");
    setPurchaseGuest(null);
    setPurchaseCode("");
    const requestedMerchant = merchantId;
    try {
      const result = await api<PurchaseGuest>(
        `/events/${state.event.id}/purchase-code/resolve`,
        "POST",
        oneTime
          ? { code: oneTime, merchantId }
          : { memberCode: member, merchantId },
        idempotencyKey()
      );
      if (!active.current || selectionRef.current !== requestedMerchant) return;
      setPurchaseGuest(result);
      setPurchaseCode(oneTime ?? "");
      setScanning(false);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      );
    } finally {
      busyRef.current = false;
      if (active.current) setScanBusy(false);
    }
  };

  const initialCodeAttempt = useRef(false);
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const pending = hash.get("purchase");
    const member = hash.get("member");
    if (
      (!pending && !member) ||
      !selectedMerchant?.active ||
      initialCodeAttempt.current
    )
      return;
    initialCodeAttempt.current = true;
    const target = pending
      ? `${window.location.origin}/merchant#purchase=${encodeURIComponent(pending)}`
      : `${window.location.origin}/merchant#member=${encodeURIComponent(member ?? "")}`;
    void resolveCode(target).catch(reason => {
      if (active.current) setFormError(errorMessage(reason));
    });
  }, [selectedMerchant?.id, selectedMerchant?.active]);

  const codeExpired =
    !purchaseGuest || Date.parse(purchaseGuest.expiresAt) <= clock;
  const buyerMemberCode = purchaseGuest?.guest.memberCode ?? "";
  const livePreorders: Preorder[] = purchaseGuest
    ? (state?.preorders ?? []).filter(
        item =>
          item.guestId === purchaseGuest.guest.id &&
          item.merchantId === selectedMerchant?.id
      )
    : [];
  // Prefer the workspace copy (refreshed every few seconds) over the snapshot
  // returned at scan time, so a collection made on another device shows up.
  const buyerPreorders: Preorder[] = purchaseGuest
    ? livePreorders.length || !purchaseGuest.preorders?.length
      ? livePreorders
      : purchaseGuest.preorders
    : [];
  const pendingBuyerPreorders = buyerPreorders.filter(
    item => item.status === "pending"
  );

  const transitionPreorder = async (
    item: Preorder,
    action: "collect" | "cancel"
  ) => {
    if (!state || preorderBusy) return;
    setPreorderBusy(item.id);
    setPreorderNotice("");
    try {
      const result = await api<{ preorder: Preorder }>(
        `/events/${state.event.id}/preorders/${encodeURIComponent(item.id)}/${action}`,
        "POST",
        {},
        idempotencyKey()
      );
      if (!active.current) return;
      setPurchaseGuest(current =>
        current
          ? {
              ...current,
              preorders: (current.preorders ?? []).map(entry =>
                entry.id === result.preorder.id ? result.preorder : entry
              ),
            }
          : current
      );
      setPreorderNotice(
        action === "collect"
          ? `已標記「${item.item}」為已取貨。`
          : `已取消「${item.item}」預購。`
      );
      void reload();
    } catch (reason) {
      if (active.current) setFormError(errorMessage(reason));
    } finally {
      if (active.current) setPreorderBusy(null);
    }
  };

  const addPreorder = async () => {
    if (!state || !purchaseGuest || !selectedMerchant || preorderBusy) return;
    const item = newPreorderItem.trim();
    const quantity = Number(newPreorderQty);
    if (!item) {
      setFormError("請輸入預購項目名稱。");
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      setFormError("數量須為 1 至 999。");
      return;
    }
    setPreorderBusy("new");
    setFormError(null);
    setPreorderNotice("");
    try {
      const result = await api<{ preorder: Preorder }>(
        `/events/${state.event.id}/preorders`,
        "POST",
        {
          merchantId: selectedMerchant.id,
          guestId: purchaseGuest.guest.id,
          item,
          quantity,
        },
        idempotencyKey()
      );
      if (!active.current) return;
      setPurchaseGuest(current =>
        current
          ? {
              ...current,
              preorders: [...(current.preorders ?? []), result.preorder],
            }
          : current
      );
      setNewPreorderItem("");
      setNewPreorderQty("1");
      setShowPreorderForm(false);
      setPreorderNotice(`已為 ${purchaseGuest.guest.name} 建立預購單。`);
      void reload();
    } catch (reason) {
      if (active.current) setFormError(errorMessage(reason));
    } finally {
      if (active.current) setPreorderBusy(null);
    }
  };
  const createReceipt = async (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    if (busyRef.current) return;
    if (!state || !selectedMerchant?.active || !amountCents) {
      setFormError("請選擇授權商戶並輸入正確金額。");
      return;
    }
    if (!legacy && (!purchaseGuest || codeExpired)) {
      setFormError("請先掃描買家的會員 QR 或輸入會員碼。");
      return;
    }
    // A blank reference gets a device-generated one, kept in the form so a
    // retry of the same transaction reuses the same reference and key.
    let finalReference = reference.trim();
    if (!finalReference) {
      finalReference = autoReference();
      setReference(finalReference);
    }
    const payload = {
      merchantId: selectedMerchant.id,
      amountCents,
      reference: finalReference,
      ...(!legacy
        ? purchaseCode
          ? { purchaseCode }
          : { memberCode: buyerMemberCode }
        : {}),
    };
    const signature = JSON.stringify(payload);
    if (
      lastAttemptSignatureRef.current &&
      lastAttemptSignatureRef.current !== signature
    )
      receiptKeyRef.current = idempotencyKey();
    lastAttemptSignatureRef.current = signature;
    busyRef.current = true;
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await api<ReceiptIssued>(
        `/events/${state.event.id}/receipts`,
        "POST",
        payload,
        receiptKeyRef.current
      );
      if (active.current) {
        setIssued(result);
        void reload();
      }
    } catch (reason) {
      if (active.current) setFormError(errorMessage(reason));
    } finally {
      busyRef.current = false;
      if (active.current) setSubmitting(false);
    }
  };
  const startNewTransaction = () => {
    setAmount("");
    setReference("");
    setIssued(null);
    setFormError(null);
    setPreorderNotice("");
    setPurchaseCode("");
    setPurchaseGuest(null);
    setScanning(true);
    lastAttemptSignatureRef.current = null;
    receiptKeyRef.current = idempotencyKey();
  };

  if (loading)
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status">
          <LoaderCircle className="event-mobile-spin" />
          正在讀取商戶工作區…
        </section>
      </main>
    );
  if (workspaceError && !state)
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status event-mobile-status--error">
          <CircleAlert />
          {workspaceError}
        </section>
      </main>
    );
  if (!session || !state || !roleAllowed)
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status event-mobile-status--error">
          <CircleAlert />
          {!session
            ? "請先以授權工作人員帳戶登入。"
            : "你的帳戶沒有商戶開單權限。"}
          {session && state && (
            <Link
              href={roleHome(state.role, state.event.mode)}
              className="event-mobile-primary"
            >
              前往{roleHomeLabel(state.role, state.event.mode)}
            </Link>
          )}
        </section>
      </main>
    );
  const currentReceipt = issued
    ? (state.receipts.find(receipt => receipt.id === issued.receipt.id) ??
      issued.receipt)
    : null;
  const issuedUrl = issued?.path
    ? new URL(issued.path, window.location.origin).toString()
    : "";
  const step: 1 | 2 | 3 = issued ? 3 : purchaseGuest || legacy ? 2 : 1;
  const singleMerchant = merchants.length === 1 ? merchants[0] : null;
  return (
    <main className="event-mobile event-mobile--merchant">
      <header
        className="event-mobile-hero"
        style={
          {
            "--event-accent": event?.brand.color ?? "#c89538",
          } as React.CSSProperties
        }
      >
        <span className="event-mobile-eyebrow">
          <Store size={14} />
          授權商戶終端
        </span>
        <h1>{event?.brand.name || "活動"}</h1>
        <p>掃描買家會員 QR → 輸入消費金額 → 買家手機彈出確認。</p>
        <p className="event-mobile-help" role="status">
          營業額約每 5 秒更新，只計有效憑證，新掃碼交易須本人確認；
          {lastUpdatedAt
            ? `上次更新：${expiryLabel(new Date(lastUpdatedAt).toISOString())}`
            : "正在取得資料…"}
          。這不是支付平台實際收款。{workspaceError && ` ${workspaceError}`}
        </p>
        <div className="merchant-return">
          <Link href="/settlements" className="event-mobile-primary">
            查看商戶對帳
          </Link>
          {staffWorkspace && (
            <Link href="/" className="event-mobile-primary">
              返回活動總覽
            </Link>
          )}
        </div>
      </header>
      {!issued ? (
        <form
          className="event-mobile-card merchant-form"
          onSubmit={createReceipt}
        >
          <div className="event-mobile-card__heading">
            <div>
              <span className="event-mobile-eyebrow">NEW RECEIPT</span>
              <h2>消費憑證</h2>
            </div>
            <ReceiptText size={23} />
          </div>
          <MerchantSteps step={step} />
          {singleMerchant ? (
            <p className="merchant-fixed">
              <span>
                {singleMerchant.name}
                <small>
                  {singleMerchant.active
                    ? "你的授權商戶"
                    : "此商戶已停用，請聯絡大會"}
                </small>
              </span>
              <Store size={18} />
            </p>
          ) : (
            <>
              <label className="event-mobile-label" htmlFor="merchant-select">
                授權商戶
              </label>
              <select
                id="merchant-select"
                value={merchantId}
                onChange={change => {
                  setMerchantId(change.target.value);
                  setPurchaseGuest(null);
                  setPurchaseCode("");
                }}
                disabled={submitting || scanBusy || !merchants.length}
              >
                {merchants.map(merchant => (
                  <option
                    key={merchant.id}
                    value={merchant.id}
                    disabled={!merchant.active}
                  >
                    {merchant.name}
                    {!merchant.active ? "（已停用）" : ""}
                  </option>
                ))}
              </select>
            </>
          )}
          {!merchants.length && (
            <p className="event-mobile-help">
              沒有你可開單的商戶，請大會管理員設定授權。
            </p>
          )}
          {!legacy && (
            <section className="consumption-scan">
              <h3>1. 掃描買家會員碼</h3>
              <p className="event-mobile-help">
                請買家打開嘉賓頁出示「我的會員 QR」；也可直接輸入會員碼（例如
                BP54）。不要掃描其登入邀請。
              </p>
              {scanning && !purchaseGuest && selectedMerchant?.active && (
                <QRScanner
                  embedded
                  disabled={scanBusy || submitting}
                  manualLabel="輸入會員碼或貼上會員 QR 連結"
                  manualPlaceholder="例如 BP54 或 https://…/merchant#member=…"
                  title="掃描買家會員 QR"
                  description="接受同一活動的會員碼或一次性消費碼；也可貼上完整 QR 連結。"
                  onDetect={resolveCode}
                />
              )}
              {scanBusy && (
                <p className="event-mobile-help" role="status">
                  <LoaderCircle className="event-mobile-spin" size={16} />{" "}
                  正在核對用戶…
                </p>
              )}
              {purchaseGuest && (
                <div className="consumption-pending">
                  <strong>
                    <CheckCircle2 size={17} />
                    {purchaseGuest.guest.name}
                  </strong>
                  <p>
                    會員碼：{purchaseGuest.guest.memberCode} · 票號：
                    {purchaseGuest.guest.ticket}
                  </p>
                  <p className="event-mobile-help">
                    {codeExpired
                      ? "此次核對已逾時，請重新掃描會員 QR。"
                      : `已核對；請於 ${expiryLabel(purchaseGuest.expiresAt)} 前完成開單`}
                  </p>
                  <div className="event-mobile-card__heading">
                    <h3>
                      <Package size={17} aria-hidden="true" /> 買家預購單
                    </h3>
                    <span className="event-mobile-pill">
                      {pendingBuyerPreorders.length} 筆未取貨
                    </span>
                  </div>
                  {buyerPreorders.length ? (
                    <PreorderList
                      items={buyerPreorders}
                      busyId={preorderBusy}
                      onCollect={item =>
                        void transitionPreorder(item, "collect")
                      }
                      onCancel={item => void transitionPreorder(item, "cancel")}
                    />
                  ) : (
                    <p className="event-mobile-help">
                      此買家在你的商戶沒有未取貨的預購單。
                    </p>
                  )}
                  {preorderNotice && (
                    <p
                      className="event-mobile-alert event-mobile-alert--success"
                      role="status"
                    >
                      <CheckCircle2 size={16} /> {preorderNotice}
                    </p>
                  )}
                  {showPreorderForm ? (
                    <div className="preorder-new">
                      <label
                        className="event-mobile-label"
                        htmlFor="preorder-item"
                      >
                        預購項目
                      </label>
                      <input
                        id="preorder-item"
                        value={newPreorderItem}
                        maxLength={200}
                        placeholder="例如 禮盒 A"
                        onChange={change =>
                          setNewPreorderItem(change.target.value)
                        }
                        disabled={preorderBusy !== null}
                      />
                      <label
                        className="event-mobile-label"
                        htmlFor="preorder-qty"
                      >
                        數量
                      </label>
                      <input
                        id="preorder-qty"
                        inputMode="numeric"
                        value={newPreorderQty}
                        onChange={change =>
                          setNewPreorderQty(change.target.value)
                        }
                        disabled={preorderBusy !== null}
                      />
                      <div className="mvp-inline-actions">
                        <button
                          type="button"
                          className="button button-dark"
                          disabled={preorderBusy !== null}
                          onClick={() => void addPreorder()}
                        >
                          {preorderBusy === "new" ? "建立中…" : "建立預購單"}
                        </button>
                        <button
                          type="button"
                          className="button button-white"
                          disabled={preorderBusy !== null}
                          onClick={() => setShowPreorderForm(false)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="event-mobile-text-button"
                      disabled={preorderBusy !== null}
                      onClick={() => setShowPreorderForm(true)}
                    >
                      <Package size={16} /> 為此買家新增預購單
                    </button>
                  )}
                </div>
              )}
              <button
                type="button"
                className={
                  purchaseGuest || !scanning
                    ? "event-mobile-primary"
                    : "event-mobile-text-button"
                }
                disabled={submitting || scanBusy || !selectedMerchant?.active}
                onClick={() => {
                  if (purchaseGuest) {
                    setPurchaseGuest(null);
                    setPurchaseCode("");
                    setFormError(null);
                    setScanning(true);
                  } else setScanning(value => !value);
                }}
              >
                <ScanLine size={18} />
                {purchaseGuest
                  ? "重新 SCAN 另一位買家"
                  : scanning
                    ? "收起掃碼器"
                    : "SCAN 買家會員 QR"}
              </button>
            </section>
          )}
          <h3>{legacy ? "記錄金額" : "2. 輸入消費金額"}</h3>
          <label className="event-mobile-label" htmlFor="receipt-amount">
            本筆實際消費金額（HKD）
          </label>
          <div className="event-mobile-amount-input">
            <span>HK$</span>
            <input
              id="receipt-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="例如 500.00"
              value={amount}
              onChange={change => setAmount(change.target.value)}
              disabled={submitting || (!legacy && !purchaseGuest)}
              aria-describedby="amount-rule"
            />
          </div>
          <p id="amount-rule" className="event-mobile-help">
            只接受正數，最多兩位小數，最高 HK$1,000,000；以整數分保存。
          </p>
          <label className="event-mobile-label" htmlFor="receipt-reference">
            商戶單據編號／交易參考（可留空，自動產生）
          </label>
          <input
            id="receipt-reference"
            value={reference}
            maxLength={200}
            onChange={change => setReference(change.target.value)}
            placeholder="留空則自動產生，例如 AUTO-20270131-170502-K3F"
            autoComplete="off"
            disabled={submitting || (!legacy && !purchaseGuest)}
          />
          <section className="merchant-estimate" aria-live="polite">
            <Ticket size={22} />
            <div>
              <span>抽獎券規則</span>
              <strong>每滿 {money(state.event.thresholdCents)} 一次機會</strong>
              <p className="event-mobile-help">
                {state.event.accumulation === "cumulative"
                  ? "跨筆累積，餘額保留；新增機會由伺服器按本人已確認消費計算。"
                  : "按每筆消費計算，不跨筆累積。"}{" "}
                用戶確認前不增加機會。
              </p>
            </div>
          </section>
          {formError && (
            <p
              className="event-mobile-alert event-mobile-alert--error"
              role="alert"
            >
              {formError}
            </p>
          )}
          <button
            className="event-mobile-primary"
            type="submit"
            disabled={
              submitting ||
              scanBusy ||
              !selectedMerchant?.active ||
              !amountCents ||
              (!legacy && (!purchaseGuest || codeExpired))
            }
          >
            {submitting ? (
              <LoaderCircle className="event-mobile-spin" size={18} />
            ) : (
              <Ticket size={18} />
            )}
            {submitting
              ? "正在建立憑證…"
              : legacy
                ? "建立憑證 QR，交由用戶確認"
                : "提交消費，買家手機彈出確認"}
          </button>
          <button
            type="button"
            className="event-mobile-text-button"
            disabled={submitting || scanBusy}
            onClick={() => {
              setLegacy(value => !value);
              setPurchaseCode("");
              setPurchaseGuest(null);
              setScanning(false);
              setFormError(null);
            }}
          >
            {legacy ? "返回：商家掃買家會員碼" : "使用原有方式：用戶掃憑證 QR"}
          </button>
        </form>
      ) : (
        currentReceipt && (
          <section
            className="event-mobile-card receipt-issued"
            aria-live="polite"
          >
            <div className="receipt-issued__success">
              <CheckCircle2 size={23} />
              <div>
                <span>憑證已建立</span>
                <h2>
                  {currentReceipt.status === "pending"
                    ? issuedUrl
                      ? "請讓用戶掃碼核對及確認"
                      : "3. 等待用戶確認"
                    : currentReceipt.status === "rejected"
                      ? "用戶已拒絕此筆消費"
                      : currentReceipt.status === "void"
                        ? "憑證已作廢"
                        : currentReceipt.claimedAt
                          ? "用戶已確認，抽獎券已記錄"
                          : "請讓用戶掃碼核對及領取"}
                </h2>
              </div>
            </div>
            {issuedUrl && (
              <QRCode
                value={issuedUrl}
                title="消費憑證 QR（用戶須核對及確認）"
              />
            )}
            {currentReceipt.status === "pending" && (
              <p>
                {issuedUrl
                  ? "請用戶掃描憑證 QR，核對商家及金額後確認。"
                  : "買家手機已彈出確認視窗，請買家核對商家及金額後按「確認」。"}
                本頁約每 5 秒更新。未確認前不計入有效營業額或抽獎機會。
              </p>
            )}
            {currentReceipt.status === "rejected" && (
              <p className="event-mobile-help">
                不計入營業額或抽獎機會。請核對實際交易後用新的交易參考重新開單。
              </p>
            )}
            <dl className="receipt-issued__details">
              <div>
                <dt>消費金額</dt>
                <dd>{money(currentReceipt.amountCents)}</dd>
              </div>
              <div>
                <dt>交易參考</dt>
                <dd>{currentReceipt.reference}</dd>
              </div>
              <div>
                <dt>本筆已記錄機會</dt>
                <dd>{currentReceipt.chances} 次</dd>
              </div>
              <div>
                <dt>大會應收（確認後有效）</dt>
                <dd>{money(currentReceipt.feeCents)}</dd>
              </div>
              <div>
                <dt>確認期限</dt>
                <dd>{expiryLabel(currentReceipt.expiresAt)}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="event-mobile-primary"
              onClick={startNewTransaction}
            >
              <RefreshCw size={18} />
              建立下一筆交易
            </button>
          </section>
        )
      )}
    </main>
  );
}
