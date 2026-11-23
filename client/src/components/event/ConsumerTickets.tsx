import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  QrCode,
  RefreshCw,
  Ticket,
} from "lucide-react";
import type { ClaimResult, GuestView, Receipt } from "@shared/eventflow";
import { apiGuest, idempotencyKey, money } from "@/lib/eventflow-api";
import QRCode from "./QRCode";

interface PurchaseCode {
  code: string;
  path: string;
  expiresAt: string;
}

export default function ConsumerTickets({
  inviteToken,
  view,
  onUpdate,
  accessPending,
}: {
  inviteToken: string;
  view: GuestView;
  onUpdate: (view: GuestView) => void;
  accessPending: boolean;
}) {
  const [code, setCode] = useState<PurchaseCode | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const keys = useRef(new Map<string, string>());
  const callback = useRef(onUpdate);
  const latestView = useRef(view);
  const revision = useRef(0);
  callback.current = onUpdate;
  latestView.current = view;

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (accessPending || document.hidden || refreshing || busyRef.current)
        return;
      refreshing = true;
      const requestRevision = revision.current;
      try {
        const next = await apiGuest<GuestView>("/guest", inviteToken);
        if (
          active &&
          requestRevision === revision.current &&
          !busyRef.current
        ) {
          callback.current(next);
          setUpdatedAt(Date.now());
          setError("");
        }
      } catch (reason) {
        if (active && requestRevision === revision.current)
          setError(
            reason instanceof Error
              ? `更新失敗，資料可能不是最新：${reason.message}`
              : "更新失敗，請重試。"
          );
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [inviteToken, accessPending]);

  const keyFor = (action: string) => {
    if (!keys.current.has(action)) keys.current.set(action, idempotencyKey());
    return keys.current.get(action)!;
  };

  const createCode = async () => {
    if (busyRef.current || accessPending) return;
    busyRef.current = true;
    setBusy("code");
    setError("");
    try {
      const next = await apiGuest<PurchaseCode>(
        "/guest/purchase-code",
        inviteToken,
        "POST",
        {},
        keyFor("code")
      );
      if (mounted.current) {
        setCode(next);
        setShowCode(true);
        keys.current.delete("code");
      }
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error ? reason.message : "未能產生消費 QR，請重試。"
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const decide = async (receipt: Receipt, confirmed: boolean) => {
    if (busyRef.current || accessPending) return;
    busyRef.current = true;
    setBusy(receipt.id);
    setError("");
    setMessage("");
    revision.current += 1;
    try {
      const result = await apiGuest<ClaimResult>(
        `/guest/receipts/${encodeURIComponent(receipt.id)}/decision`,
        inviteToken,
        "POST",
        { confirmed },
        keyFor(`${receipt.id}:${confirmed}`)
      );
      if (!mounted.current) return;
      // The decision response is authoritative. Remove its buttons even if refresh fails.
      const current = latestView.current;
      callback.current({
        ...current,
        guest: { ...current.guest, chances: result.total },
        receipts: current.receipts.map(item =>
          item.id === result.receipt.id ? result.receipt : item
        ),
      });
      setMessage(
        confirmed
          ? result.alreadyClaimed
            ? `此筆消費已確認，共有 ${result.total} 次機會。`
            : `已確認消費，新增 ${result.gained} 次機會；目前共有 ${result.total} 次。`
          : "已拒絕此筆消費，不會增加抽獎機會或計入營業額。"
      );
      try {
        const refreshed = await apiGuest<GuestView>("/guest", inviteToken);
        if (mounted.current) {
          callback.current(refreshed);
          setUpdatedAt(Date.now());
        }
      } catch (reason) {
        if (mounted.current)
          setError(
            `交易決定已保存，但最新清單暫未讀取：${reason instanceof Error ? reason.message : "請稍後刷新。"}`
          );
      }
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "確認未完成，請以相同資料重試。"
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const confirmed = view.receipts.filter(
    receipt =>
      receipt.status === "valid" &&
      receipt.claimedAt &&
      receipt.guestId === view.guest.id
  );
  const totalCents = confirmed.reduce(
    (sum, receipt) => sum + receipt.amountCents,
    0
  );
  const currentCents = confirmed
    .filter(receipt => receipt.ruleVersion === view.event.ruleVersion)
    .reduce((sum, receipt) => sum + receipt.amountCents, 0);
  const threshold = view.event.thresholdCents;
  const pending = view.receipts.filter(receipt => receipt.status === "pending");
  const expired = !code || Date.parse(code.expiresAt) <= clock;

  return (
    <section
      className="event-mobile-card consumption-tickets"
      aria-labelledby="consumption-tickets-title"
    >
      <div className="event-mobile-card__heading">
        <div>
          <span className="event-mobile-eyebrow">SPEND & EARN</span>
          <h2 id="consumption-tickets-title">消費領抽獎券</h2>
        </div>
        <Ticket size={24} />
      </div>
      <p>出示你的消費 QR，讓商家掃描及輸入金額，再由你核對並確認。</p>
      <p className="event-mobile-help">
        {view.event.accumulation === "cumulative"
          ? `已確認消費跨筆累積，每滿 ${money(threshold)} 得一次一般抽獎機會，未滿餘額保留。`
          : `每筆已確認消費每滿 ${money(threshold)} 得一次一般抽獎機會；此活動不跨筆累積。`}{" "}
        待確認及已拒絕的消費不會計算。
      </p>
      <div className="guest-stat-grid">
        <article className="guest-stat">
          <span>已確認消費總額</span>
          <strong>{money(totalCents)}</strong>
        </article>
        <article className="guest-stat">
          <span>目前抽獎機會</span>
          <strong>
            {view.guest.chances}
            <small> 次</small>
          </strong>
        </article>
      </div>
      {view.event.accumulation === "cumulative" && (
        <p className="event-mobile-help">
          本規則累積 {money(currentCents)}；再消費{" "}
          {money(threshold - (currentCents % threshold))}{" "}
          可達下一次機會。歷史憑證保留當時規則。
        </p>
      )}
      <button
        type="button"
        className="event-mobile-primary"
        disabled={busy !== null || accessPending}
        onClick={() => {
          if (!showCode || expired) void createCode();
          else setShowCode(false);
        }}
      >
        {busy === "code" ? (
          <LoaderCircle size={18} className="event-mobile-spin" />
        ) : (
          <QrCode size={18} />
        )}
        {busy === "code"
          ? "正在產生…"
          : showCode && !expired
            ? "收起我的 QR code"
            : "SHOW 我的 QR code"}
      </button>
      {showCode && code && (
        <div className="consumption-qr">
          {expired ? (
            <p role="status">
              消費 QR 已過期，請按下方按鈕更新後讓商家重新掃描。
            </p>
          ) : (
            <QRCode value={code.path} title="我的消費 QR（只供授權商家掃描）" />
          )}
          <p className="event-mobile-help">
            有效至{" "}
            {new Date(code.expiresAt).toLocaleTimeString("zh-HK", {
              timeZone: "Asia/Hong_Kong",
            })}
            （香港時間）。此碼不是登入憑證，不會公開電話或電郵。請只向現場商家出示。
          </p>
          <button
            type="button"
            className="event-mobile-text-button"
            disabled={busy !== null || accessPending}
            onClick={() => void createCode()}
          >
            <RefreshCw size={16} />
            更新消費 QR
          </button>
        </div>
      )}
      {message && (
        <p
          className="event-mobile-alert event-mobile-alert--success"
          role="status"
        >
          <CheckCircle2 size={17} />
          {message}
        </p>
      )}
      {error && (
        <p
          className="event-mobile-alert event-mobile-alert--error"
          role="alert"
        >
          <CircleAlert size={17} />
          {error}
        </p>
      )}
      <div className="event-mobile-card__heading">
        <h3>待你確認的消費</h3>
        <span className="event-mobile-pill">{pending.length} 筆</span>
      </div>
      <p className="event-mobile-help">
        約每 5 秒更新
        {updatedAt
          ? `；上次 ${new Date(updatedAt).toLocaleTimeString("zh-HK")}`
          : ""}
        。請核對實際交易，金額有誤可拒絕並請商家重新開單。
      </p>
      {!pending.length && (
        <p className="event-mobile-empty">
          未有待確認消費。先讓商家掃描上方 QR。
        </p>
      )}
      {pending.map(receipt => {
        const receiptExpired = Date.parse(receipt.expiresAt) <= clock;
        return (
          <article className="consumption-pending" key={receipt.id}>
            <strong>{receipt.merchantName || "活動授權商戶"}</strong>
            <h3>{money(receipt.amountCents)}</h3>
            <p>交易參考：{receipt.reference}</p>
            <p className="event-mobile-help">
              {new Date(receipt.createdAt).toLocaleString("zh-HK")} ·{" "}
              {receiptExpired
                ? "已過確認期限，請商家重開"
                : "待本人確認，不代表平台已收款"}
            </p>
            <div className="mvp-inline-actions">
              <button
                type="button"
                className="event-mobile-primary"
                disabled={busy !== null || accessPending || receiptExpired}
                onClick={() => void decide(receipt, true)}
              >
                {busy === receipt.id ? "處理中…" : "確認金額並領抽獎券"}
              </button>
              <button
                type="button"
                className="button button-white"
                disabled={busy !== null || accessPending || receiptExpired}
                onClick={() => void decide(receipt, false)}
              >
                金額有誤／拒絕
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
