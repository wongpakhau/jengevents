import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Gift,
  LoaderCircle,
  LogOut,
  ReceiptText,
  ScanLine,
  Ticket,
  Users,
} from "lucide-react";
import { apiGuest, idempotencyKey, money } from "@/lib/eventflow-api";
import { formatEventDate, formatEventVenue } from "@/lib/event-date";
import QRScanner from "@/components/event/QRScanner";
import { useParticipantAccessPending } from "@/components/event/ParticipantSessionGuard";
import type { ClaimResult, GuestView } from "@shared/eventflow";
import { classLabel } from "@shared/registration";
import { ELITE_GUEST_EVENT_SLUG } from "@shared/young-friends";
import EliteGuestQuickActions from "@/components/event/EliteGuestQuickActions";
import "@/styles/event-mobile.css";

const INVITE_STORAGE_KEY = "eventflow.guest-invite";

function storedValue(kind: "localStorage" | "sessionStorage", key: string) {
  try {
    return window[kind].getItem(key);
  } catch {
    return null;
  }
}

function storeInvite(token: string, remember: boolean) {
  try {
    if (remember) {
      window.localStorage.setItem(INVITE_STORAGE_KEY, token);
      window.sessionStorage.removeItem(INVITE_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(INVITE_STORAGE_KEY, token);
      window.localStorage.removeItem(INVITE_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private browsing; the current tab still works.
  }
}

function hashValue(name: "invite" | "claim", rawHash = window.location.hash) {
  const hash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  return new URLSearchParams(hash).get(name);
}

function valueFromScannedLink(raw: string, name: "invite" | "claim") {
  try {
    return new URL(raw, window.location.origin).hash
      ? hashValue(name, new URL(raw, window.location.origin).hash)
      : null;
  } catch {
    return hashValue(name, raw);
  }
}

function isBareToken(raw: string) {
  const value = raw.trim();
  return (
    Boolean(value) &&
    !value.includes("#") &&
    !value.includes("://") &&
    !value.includes("=")
  );
}

function replaceGuestHash(invite: string | null, claim: string | null) {
  const values = new URLSearchParams();
  if (invite) values.set("invite", invite);
  if (claim) values.set("claim", claim);
  const url = `${window.location.pathname}${window.location.search}${values.size ? `#${values.toString()}` : ""}`;
  window.history.replaceState(null, "", url);
}

function requestError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function receiptState(receipt: GuestView["receipts"][number]) {
  if (receipt.status === "void") return "已作廢";
  if (receipt.claimedAt) return "已領取";
  return "尚未領取";
}

export default function GuestPortal() {
  const accessPending = useParticipantAccessPending();
  const [inviteToken, setInviteToken] = useState<string | null>(() => {
    const hashInvite = hashValue("invite");
    return (
      hashInvite ||
      storedValue("sessionStorage", INVITE_STORAGE_KEY) ||
      storedValue("localStorage", INVITE_STORAGE_KEY)
    );
  });
  const [pendingClaim, setPendingClaim] = useState<string | null>(() =>
    hashValue("claim")
  );
  const [rememberInvite, setRememberInvite] = useState(() =>
    Boolean(storedValue("localStorage", INVITE_STORAGE_KEY))
  );
  const [guestView, setGuestView] = useState<GuestView | null>(null);
  const [loading, setLoading] = useState(Boolean(inviteToken));
  const [claiming, setClaiming] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claimKeyRef = useRef(idempotencyKey());
  const claimTokenRef = useRef<string | null>(pendingClaim);
  const autoClaimAttempt = useRef("");

  const loadGuest = useCallback(async () => {
    if (!inviteToken) {
      setGuestView(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await apiGuest<GuestView>("/guest", inviteToken);
      setGuestView(response);
    } catch (loadError) {
      setGuestView(null);
      setError(
        requestError(loadError, "未能讀取嘉賓資料。請確認邀請連結仍然有效。")
      );
    } finally {
      setLoading(false);
    }
  }, [inviteToken]);

  useEffect(() => {
    if (inviteToken) storeInvite(inviteToken, rememberInvite);
  }, [inviteToken, rememberInvite]);

  useEffect(() => {
    const onHashChange = () => {
      const hashInvite = hashValue("invite");
      const hashClaim = hashValue("claim");
      if (hashInvite) setInviteToken(hashInvite);
      if (hashClaim) setPendingClaim(hashClaim);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    void loadGuest();
  }, [loadGuest]);

  useEffect(() => {
    if (claimTokenRef.current !== pendingClaim) {
      claimTokenRef.current = pendingClaim;
      claimKeyRef.current = idempotencyKey();
    }
  }, [pendingClaim]);

  const claimReceipt = useCallback(async () => {
    if (!inviteToken || !pendingClaim || claiming || accessPending) return;
    setClaiming(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiGuest<ClaimResult>(
        "/guest/claim",
        inviteToken,
        "POST",
        { token: pendingClaim },
        claimKeyRef.current
      );
      setMessage(
        result.alreadyClaimed
          ? `此憑證已領取；你目前共有 ${result.total} 次抽獎機會。`
          : `成功增加 ${result.gained} 次抽獎機會；你目前共有 ${result.total} 次。`
      );
      setPendingClaim(null);
      replaceGuestHash(inviteToken, null);
      await loadGuest();
    } catch (claimError) {
      // Keep the same pending token and key: a retry cannot duplicate a claim.
      setError(
        requestError(claimError, "未能領取消費憑證。請以相同 QR 再試一次。")
      );
    } finally {
      setClaiming(false);
    }
  }, [claiming, inviteToken, loadGuest, pendingClaim, accessPending]);

  useEffect(() => {
    if (
      !inviteToken ||
      !pendingClaim ||
      !guestView ||
      loading ||
      claiming ||
      accessPending
    )
      return;
    const attempt = `${inviteToken}:${pendingClaim}`;
    if (autoClaimAttempt.current === attempt) return;
    autoClaimAttempt.current = attempt;
    void claimReceipt();
  }, [
    inviteToken,
    pendingClaim,
    guestView,
    loading,
    claiming,
    claimReceipt,
    accessPending,
  ]);

  const handleScan = async (raw: string) => {
    if (accessPending) throw new Error("正在確認登入狀態，請稍後再掃描。");
    let scannedInvite = valueFromScannedLink(raw, "invite");
    let scannedClaim = valueFromScannedLink(raw, "claim");

    // Raw tokens have no type marker. The safe context rule is invitation first:
    // without an established guest capability they are treated as invitations;
    // after identity is established they are treated as pending receipt claims.
    if (!scannedInvite && !scannedClaim && isBareToken(raw)) {
      if (inviteToken) scannedClaim = raw.trim();
      else scannedInvite = raw.trim();
    }

    if (scannedInvite) {
      setInviteToken(scannedInvite);
      setGuestView(null);
      setError(null);
      setMessage("嘉賓邀請已確認。資料正在更新。");
      if (scannedClaim) setPendingClaim(scannedClaim);
      replaceGuestHash(scannedInvite, scannedClaim ?? pendingClaim);
      setShowScanner(false);
      return;
    }
    if (scannedClaim) {
      setPendingClaim(scannedClaim);
      setError(null);
      setMessage(
        inviteToken
          ? "已讀取消費憑證，可立即領取。"
          : "已暫存消費憑證。請先掃描你的嘉賓邀請 QR，身份確認後即可領取。"
      );
      replaceGuestHash(inviteToken, scannedClaim);
      setShowScanner(false);
      return;
    }
    throw new Error("這不是有效的嘉賓邀請或消費憑證連結。請掃描完整 QR code。");
  };

  const forgetInvite = () => {
    try {
      window.sessionStorage.removeItem(INVITE_STORAGE_KEY);
      window.localStorage.removeItem(INVITE_STORAGE_KEY);
    } catch {
      // Continue clearing the in-memory capability even if browser storage is blocked.
    }
    setInviteToken(null);
    setGuestView(null);
    setMessage(null);
    setError(null);
    replaceGuestHash(null, pendingClaim);
  };

  const event = guestView?.event;
  const guest = guestView?.guest;
  const eliteQuickActions = event?.slug === ELITE_GUEST_EVENT_SLUG && event.mode === "attendance";

  return (
    <main
      className="event-mobile event-mobile--guest"
      style={
        {
          "--event-accent": event?.brand.color || "#c89538",
        } as React.CSSProperties
      }
    >
      <header
        className="event-mobile-hero"
        style={
          {
            "--event-accent": event?.brand.color ?? "#c89538",
          } as React.CSSProperties
        }
      >
        <span className="event-mobile-eyebrow">
          <Ticket size={14} /> 嘉賓自助服務
        </span>
        {event?.brand.logoUrl && (
          <img
            className="event-mobile-brand-logo"
            src={event.brand.logoUrl}
            alt={event.brand.name}
            referrerPolicy="no-referrer"
            width={64}
            height={64}
          />
        )}
        <h1>{event?.brand.name ?? "你的活動邀請"}</h1>
        <p>
          {event
            ? `${event.name} · ${formatEventDate(event.date)} · ${formatEventVenue(event.venue)}`
            : "掃描嘉賓邀請 QR，查看你的座位、消費憑證與抽獎機會。"}
        </p>
      </header>

      {!inviteToken && (
        <section className="event-mobile-card event-mobile-status">
          <Users size={24} />
          <h2>先確認你的嘉賓身份</h2>
          <p>消費憑證不是身份憑證。請先掃描大會發出的個人嘉賓邀請 QR。</p>
        </section>
      )}

      {inviteToken && (
        <section className="event-mobile-card guest-capability">
          <label className="event-mobile-check">
            <input
              type="checkbox"
              checked={rememberInvite}
              onChange={event => setRememberInvite(event.target.checked)}
            />{" "}
            <span>在此裝置記住我的嘉賓邀請</span>
          </label>
          <p className="event-mobile-help">
            預設只在此瀏覽工作階段保存。不要在共用裝置勾選此項。
          </p>
          <button
            type="button"
            className="event-mobile-text-button"
            onClick={forgetInvite}
          >
            <LogOut size={15} /> 移除此裝置上的嘉賓邀請
          </button>
        </section>
      )}

      {message && (
        <p
          className="event-mobile-alert event-mobile-alert--success"
          role="status"
        >
          <CheckCircle2 size={17} /> {message}
        </p>
      )}
      {error && (
        <div
          className="event-mobile-alert event-mobile-alert--error"
          role="alert"
        >
          <CircleAlert size={17} /> <span>{error}</span>
          <button
            type="button"
            onClick={() =>
              pendingClaim && inviteToken
                ? void claimReceipt()
                : void loadGuest()
            }
          >
            重試
          </button>
        </div>
      )}

      {pendingClaim && !inviteToken && (
        <section className="event-mobile-card pending-claim">
          <ReceiptText size={22} />
          <div>
            <h2>消費憑證已暫存</h2>
            <p>請先掃描嘉賓邀請 QR。暫存憑證不會遺失。</p>
          </div>
        </section>
      )}
      {pendingClaim && inviteToken && (
        <section className="event-mobile-card pending-claim">
          <Gift size={22} />
          <div>
            <h2>可領取消費憑證</h2>
            <p>身份已確認後，才會由伺服器把權益加入你的帳戶。</p>
          </div>
          <button
            type="button"
            className="event-mobile-primary"
            onClick={() => void claimReceipt()}
            disabled={claiming}
          >
            {claiming ? (
              <LoaderCircle className="event-mobile-spin" size={18} />
            ) : (
              <Gift size={18} />
            )}
            {claiming ? "正在領取…" : "立即領取"}
          </button>
        </section>
      )}

      {loading && (
        <section className="event-mobile-card event-mobile-status">
          <LoaderCircle className="event-mobile-spin" /> 正在讀取你的活動資料…
        </section>
      )}

      {guest && event && !loading && (
        <>
          <section className="event-mobile-card guest-welcome">
            <div>
              <span className="event-mobile-eyebrow">WELCOME</span>
              <h2>{guest.name}</h2>
              <p>{guest.checkedInAt ? "已完成到場簽到" : "尚未簽到"}</p>
              {classLabel(guest) && <p>班級：{classLabel(guest)}</p>}
              {guest.chapter && <p>分會：{guest.chapter}</p>}
              {guest.invitedBy && <p>邀請人：{guest.invitedBy}</p>}
            </div>
            <span
              className={`event-mobile-pill ${guest.checkedInAt ? "event-mobile-pill--success" : ""}`}
            >
              {guest.checkedInAt ? "已到場" : "待到場"}
            </span>
          </section>

          {eliteQuickActions && (
            <EliteGuestQuickActions key={guest.id} table={guestView?.table ?? null} />
          )}
          {!eliteQuickActions && <section className="guest-stat-grid">
            {event.mode !== "attendance" && (
              <article className="event-mobile-card guest-stat">
                <span>累積抽獎機會</span>
                <strong>
                  {guest.chances}
                  <small> 次</small>
                </strong>
                <Ticket size={22} />
              </article>
            )}
            <article className="event-mobile-card guest-stat">
              <span>你的座位</span>
              <strong>
                {guestView?.table ? `${guestView.table.number} 號枱` : "待安排"}
              </strong>
              <small>
                {guestView?.table
                  ? `${guestView.table.label} · 座位 ${guestView.table.seat ?? "待安排"}`
                  : "詳情請向大會查詢"}
              </small>
            </article>
          </section>}

          {event.mode !== "attendance" && (
            <>
              <section className="event-mobile-card guest-list">
                <div className="event-mobile-card__heading">
                  <div>
                    <span className="event-mobile-eyebrow">RECEIPTS</span>
                    <h2>我的消費憑證</h2>
                  </div>
                  <ReceiptText size={22} />
                </div>
                {guestView?.receipts.length ? (
                  guestView.receipts.map(receipt => (
                    <div className="guest-list__row" key={receipt.id}>
                      <div>
                        <strong>{money(receipt.amountCents)}</strong>
                        <span>
                          {new Date(receipt.createdAt).toLocaleString("zh-HK")}
                        </span>
                      </div>
                      <span
                        className={`event-mobile-pill ${receipt.claimedAt ? "event-mobile-pill--success" : ""}`}
                      >
                        {receiptState(receipt)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="event-mobile-empty">
                    尚未有消費憑證。於商戶消費後掃描其 QR 即可領取。
                  </p>
                )}
              </section>

              <section className="event-mobile-card guest-list">
                <div className="event-mobile-card__heading">
                  <div>
                    <span className="event-mobile-eyebrow">
                      REVEALED RESULTS
                    </span>
                    <h2>已公布結果</h2>
                  </div>
                  <Gift size={22} />
                </div>
                {guestView?.draws.length ? (
                  guestView.draws.map(draw => (
                    <div className="guest-list__row" key={draw.id}>
                      <div>
                        <strong>{draw.prizeName}</strong>
                        <span>
                          {draw.winner.name} · 票號 {draw.winner.ticket}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="event-mobile-empty">大會尚未公布抽獎結果。</p>
                )}
              </section>
            </>
          )}
        </>
      )}

      <section className="event-mobile-card guest-scan">
        <button
          type="button"
          className="event-mobile-primary"
          onClick={() => setShowScanner(value => !value)}
        >
          <ScanLine size={18} />
          {showScanner
            ? "收起掃碼器"
            : event?.mode === "attendance"
              ? "掃描個人嘉賓邀請"
              : "掃描嘉賓邀請或消費憑證"}
        </button>
        {showScanner && (
          <QRScanner
            onDetect={handleScan}
            title="掃描活動 QR code"
            description={
              event?.mode === "attendance"
                ? "只用於讀取你的個人嘉賓邀請；現場共用QR請用手機相機開啟。"
                : "可掃描嘉賓邀請或商戶消費憑證；相機需要你手動開啟。"
            }
          />
        )}
      </section>
    </main>
  );
}
