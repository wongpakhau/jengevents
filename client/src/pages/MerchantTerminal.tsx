import { useEffect, useMemo, useRef, useState } from "react";
import QRCodeLibrary from "qrcode";
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
  Store,
  Ticket,
} from "lucide-react";
import { api, idempotencyKey, money } from "@/lib/eventflow-api";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import type { ReceiptIssued } from "@shared/eventflow";
import "@/styles/event-mobile.css";

const amountPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

function toCents(value: string) {
  if (!amountPattern.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "未能建立消費憑證，請稍後以相同資料重試。";
}

function expiryLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(date);
}

/** The rendered bitmap encodes the one-time server-issued path, never a mock value. */
function QRCode({ value, title }: { value: string; title: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    QRCodeLibrary.toDataURL(value, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#202321", light: "#fffdf8" },
    })
      .then(dataUrl => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setError("QR code 無法產生，請重新建立這筆交易。");
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  return (
    <figure className="receipt-qr">
      {src ? (
        <img src={src} alt={title} />
      ) : (
        <div className="receipt-qr__loading">
          <LoaderCircle className="event-mobile-spin" size={24} />
        </div>
      )}
      <figcaption>{error ?? title}</figcaption>
    </figure>
  );
}

export default function MerchantTerminal() {
  const {
    session,
    state,
    loading,
    error: workspaceError,
    reload,
  } = useWorkspace();
  const [merchantId, setMerchantId] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [issued, setIssued] = useState<ReceiptIssued | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const receiptKeyRef = useRef(idempotencyKey());
  const lastAttemptSignatureRef = useRef<string | null>(null);

  const merchants = state?.merchants ?? [];
  const event = state?.event;
  const roleAllowed =
    state &&
    ["owner", "admin", "project_manager", "merchant"].includes(state.role);
  const amountCents = toCents(amount);
  const selectedMerchant =
    merchants.find(merchant => merchant.id === merchantId) ?? null;

  useEffect(() => {
    if (!merchants.length) {
      setMerchantId("");
      return;
    }
    if (!merchants.some(merchant => merchant.id === merchantId)) {
      setMerchantId(merchants[0].id);
    }
  }, [merchantId, merchants]);

  const estimatedChances = useMemo(() => {
    if (!event || !amountCents || event.accumulation !== "per_transaction")
      return null;
    return Math.floor(amountCents / event.thresholdCents);
  }, [amountCents, event]);

  const createReceipt = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!state || !selectedMerchant || !amountCents) {
      setFormError("請選擇授權商戶，並輸入正確的港幣金額。");
      return;
    }
    const trimmedReference = reference.trim();
    if (!trimmedReference) {
      setFormError("請輸入商戶單據編號或交易參考。");
      return;
    }

    const payload = {
      merchantId: selectedMerchant.id,
      amountCents,
      reference: trimmedReference,
    };
    const signature = JSON.stringify(payload);
    if (
      lastAttemptSignatureRef.current &&
      lastAttemptSignatureRef.current !== signature
    ) {
      receiptKeyRef.current = idempotencyKey();
    }
    lastAttemptSignatureRef.current = signature;

    setSubmitting(true);
    setFormError(null);
    try {
      const result = await api<ReceiptIssued>(
        `/events/${state.event.id}/receipts`,
        "POST",
        payload,
        receiptKeyRef.current
      );
      setIssued(result);
      void reload();
    } catch (requestError) {
      // Preserve both payload and key so an identical retry is server-idempotent.
      setFormError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const startNewTransaction = () => {
    setAmount("");
    setReference("");
    setIssued(null);
    setFormError(null);
    lastAttemptSignatureRef.current = null;
    receiptKeyRef.current = idempotencyKey();
  };

  if (loading) {
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status">
          <LoaderCircle className="event-mobile-spin" /> 正在讀取商戶工作區…
        </section>
      </main>
    );
  }
  if (workspaceError) {
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status event-mobile-status--error">
          <CircleAlert /> {workspaceError}
        </section>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status event-mobile-status--error">
          <CircleAlert /> 請先以授權的工作人員帳戶登入。
        </section>
      </main>
    );
  }
  if (!state || !roleAllowed) {
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status event-mobile-status--error">
          <CircleAlert /> 你的帳戶沒有商戶開單權限。
        </section>
      </main>
    );
  }

  const issuedUrl = issued
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
          <Store size={14} /> 授權商戶終端
        </span>
        <h1>{event?.brand.name || "活動"}</h1>
        <p>輸入實際消費並確認，伺服器才會建立一張可領取的專屬憑證。</p>
      </header>

      {!issued ? (
        <form
          className="event-mobile-card merchant-form"
          onSubmit={createReceipt}
        >
          <div className="event-mobile-card__heading">
            <div>
              <span className="event-mobile-eyebrow">NEW RECEIPT</span>
              <h2>記錄這筆消費</h2>
            </div>
            <ReceiptText size={23} />
          </div>

          <label className="event-mobile-label" htmlFor="merchant-select">
            授權商戶
          </label>
          <select
            id="merchant-select"
            value={merchantId}
            onChange={event => setMerchantId(event.target.value)}
            disabled={submitting || merchants.length === 0}
          >
            {merchants.map(merchant => (
              <option
                value={merchant.id}
                key={merchant.id}
                disabled={!merchant.active}
              >
                {merchant.name}
                {merchant.active ? "" : "（已停用）"}
              </option>
            ))}
          </select>
          {!merchants.length && (
            <p className="event-mobile-help">
              此活動目前沒有你可開單的商戶。請由大會管理員設定授權。
            </p>
          )}
          {selectedMerchant && !selectedMerchant.active && (
            <p className="event-mobile-alert event-mobile-alert--error">
              此商戶已停用，不能建立新憑證。
            </p>
          )}

          <label className="event-mobile-label" htmlFor="receipt-amount">
            本筆消費金額（HKD）
          </label>
          <div className="event-mobile-amount-input">
            <span>HK$</span>
            <input
              id="receipt-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="例如 2500.00"
              value={amount}
              onChange={event => setAmount(event.target.value)}
              disabled={submitting}
              aria-describedby="amount-rule"
            />
          </div>
          <p id="amount-rule" className="event-mobile-help">
            只接受正數，最多兩位小數；金額會以整數分傳送及保存。
          </p>

          <label className="event-mobile-label" htmlFor="receipt-reference">
            商戶單據編號／交易參考
          </label>
          <input
            id="receipt-reference"
            value={reference}
            onChange={event => setReference(event.target.value)}
            placeholder="例如 POS-20261030-0042"
            autoComplete="off"
            disabled={submitting}
          />

          <section className="merchant-estimate" aria-live="polite">
            <Ticket size={22} />
            <div>
              <span>
                {event?.accumulation === "cumulative"
                  ? "跨筆累積估算"
                  : "本筆規則估算"}
              </span>
              {event?.accumulation === "cumulative" ? (
                <strong>最終新增機會由伺服器按累積規則確認</strong>
              ) : (
                <strong>
                  {estimatedChances === null
                    ? "輸入有效金額後顯示"
                    : `${estimatedChances} 次機會（估算）`}
                </strong>
              )}
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
              !selectedMerchant?.active ||
              !amountCents ||
              !reference.trim()
            }
          >
            {submitting ? (
              <LoaderCircle className="event-mobile-spin" size={18} />
            ) : (
              <Ticket size={18} />
            )}
            {submitting ? "正在建立憑證…" : "確認並建立領取 QR"}
          </button>
        </form>
      ) : (
        <section
          className="event-mobile-card receipt-issued"
          aria-live="polite"
        >
          <div className="receipt-issued__success">
            <CheckCircle2 size={23} />
            <div>
              <span>憑證已建立</span>
              <h2>請讓嘉賓掃描領取</h2>
            </div>
          </div>
          <QRCode value={issuedUrl} title="嘉賓消費憑證 QR code" />
          <dl className="receipt-issued__details">
            <div>
              <dt>消費金額</dt>
              <dd>{money(issued.receipt.amountCents)}</dd>
            </div>
            <div>
              <dt>本筆可得</dt>
              <dd>{issued.possibleChances} 次機會</dd>
            </div>
            <div>
              <dt>大會應收抽獎費</dt>
              <dd>{money(issued.receipt.feeCents)}</dd>
            </div>
            <div>
              <dt>到期時間</dt>
              <dd>{expiryLabel(issued.receipt.expiresAt)}</dd>
            </div>
            <div>
              <dt>交易參考</dt>
              <dd>{issued.receipt.reference}</dd>
            </div>
          </dl>
          <p className="event-mobile-help">
            此 QR
            只包含一次性消費領取憑證，不會建立嘉賓身份。嘉賓需先使用自己的邀請連結。
          </p>
          <button
            type="button"
            className="event-mobile-primary"
            onClick={startNewTransaction}
          >
            <RefreshCw size={18} /> 建立下一筆交易
          </button>
        </section>
      )}
    </main>
  );
}
