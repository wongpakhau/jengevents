import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
  ScanLine,
  Store,
  Ticket,
} from "lucide-react";
import { api, idempotencyKey, money } from "@/lib/eventflow-api";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { stateScopeKey } from "@/lib/workspace-scope";
import QRScanner from "@/components/event/QRScanner";
import QRCode from "@/components/event/QRCode";
import { purchaseCodeFromQr } from "@/lib/purchase-qr";
import type { ReceiptIssued } from "@shared/eventflow";
import "@/styles/event-mobile.css";

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
interface PurchaseGuest {
  guest: { id: string; name: string; ticket: string };
  expiresAt: string;
}

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
  const [scanning, setScanning] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [purchaseCode, setPurchaseCode] = useState("");
  const [purchaseGuest, setPurchaseGuest] = useState<PurchaseGuest | null>(
    null
  );
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
    const code = purchaseCodeFromQr(raw, window.location.origin);
    if (!code)
      throw new Error(
        "請掃描用戶『消費領抽獎券』頁面的完整 QR；邀請或登入 QR 不適用。"
      );
    if (!state || !selectedMerchant?.active || busyRef.current)
      throw new Error("請先選擇授權且啟用中的商戶。");
    busyRef.current = true;
    setScanBusy(true);
    setFormError(null);
    setPurchaseGuest(null);
    setPurchaseCode("");
    const requestedMerchant = merchantId;
    try {
      const result = await api<PurchaseGuest>(
        `/events/${state.event.id}/purchase-code/resolve`,
        "POST",
        { code, merchantId },
        idempotencyKey()
      );
      if (!active.current || selectionRef.current !== requestedMerchant) return;
      setPurchaseGuest(result);
      setPurchaseCode(code);
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
    const pending = new URLSearchParams(window.location.hash.slice(1)).get(
      "purchase"
    );
    if (!pending || !selectedMerchant?.active || initialCodeAttempt.current)
      return;
    initialCodeAttempt.current = true;
    void resolveCode(
      `${window.location.origin}/merchant#purchase=${encodeURIComponent(pending)}`
    ).catch(reason => {
      if (active.current) setFormError(errorMessage(reason));
    });
  }, [selectedMerchant?.id, selectedMerchant?.active]);

  const codeExpired =
    !purchaseGuest || Date.parse(purchaseGuest.expiresAt) <= clock;
  const createReceipt = async (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    if (busyRef.current) return;
    if (
      !state ||
      !selectedMerchant?.active ||
      !amountCents ||
      !reference.trim()
    ) {
      setFormError("請選擇授權商戶，輸入正確金額及交易參考。");
      return;
    }
    if (!legacy && (!purchaseCode || codeExpired)) {
      setFormError("請先掃描用戶有效的消費 QR。");
      return;
    }
    const payload = {
      merchantId: selectedMerchant.id,
      amountCents,
      reference: reference.trim(),
      ...(!legacy ? { purchaseCode } : {}),
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
    setPurchaseCode("");
    setPurchaseGuest(null);
    setScanning(false);
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
        <p>掃描用戶 QR → 記錄消費金額 → 等待用戶確認。</p>
        <p className="event-mobile-help" role="status">
          營業額約每 5 秒更新，只計有效憑證，新掃碼交易須本人確認；
          {lastUpdatedAt
            ? `上次更新：${expiryLabel(new Date(lastUpdatedAt).toISOString())}`
            : "正在取得資料…"}
          。這不是支付平台實際收款。{workspaceError && ` ${workspaceError}`}
        </p>
        <Link href="/settlements" className="event-mobile-primary">
          查看商戶對帳
        </Link>
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
          {!merchants.length && (
            <p className="event-mobile-help">
              沒有你可開單的商戶，請大會管理員設定授權。
            </p>
          )}
          {!legacy && (
            <section className="consumption-scan">
              <h3>1. 掃描用戶 QR</h3>
              <p className="event-mobile-help">
                請用戶打開「消費領抽獎券」，出示個人的消費 QR
                code；不要掃描其登入邀請。
              </p>
              <button
                type="button"
                className="event-mobile-primary"
                disabled={submitting || scanBusy || !selectedMerchant?.active}
                onClick={() => setScanning(value => !value)}
              >
                <ScanLine size={18} />
                {scanBusy
                  ? "正在核對…"
                  : scanning
                    ? "收起掃碼器"
                    : "SCAN 用戶 QR code"}
              </button>
              {scanning && (
                <QRScanner
                  embedded
                  disabled={scanBusy || submitting}
                  manualLabel="貼上用戶消費 QR 的完整連結"
                  manualPlaceholder="https://…/merchant#purchase=…"
                  title="掃描用戶消費 QR"
                  description="只接受同一活動的消費識別碼；也可貼上完整 QR 連結。"
                  onDetect={resolveCode}
                />
              )}
              {purchaseGuest && (
                <div className="consumption-pending">
                  <strong>
                    <CheckCircle2 size={17} />
                    {purchaseGuest.guest.name}
                  </strong>
                  <p>票號：{purchaseGuest.guest.ticket}</p>
                  <p className="event-mobile-help">
                    {codeExpired
                      ? "此 QR 已過期，請用戶更新並重新掃描。"
                      : `已核對；消費碼有效至 ${expiryLabel(purchaseGuest.expiresAt)}`}
                  </p>
                </div>
              )}
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
            商戶單據編號／交易參考
          </label>
          <input
            id="receipt-reference"
            value={reference}
            maxLength={200}
            onChange={change => setReference(change.target.value)}
            placeholder="例如 POS-20270131-0042"
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
              !reference.trim() ||
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
                : "提交消費，等待用戶確認"}
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
            {legacy ? "返回：商家掃用戶 QR" : "使用原有方式：用戶掃憑證 QR"}
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
                  : "請用戶在自己的『消費領抽獎券』頁面確認商家及金額。"}
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
