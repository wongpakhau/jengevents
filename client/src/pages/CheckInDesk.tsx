import { useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  LoaderCircle,
  ScanLine,
  Search,
  UserCheck,
  Users,
} from "lucide-react";
import { api, idempotencyKey } from "@/lib/eventflow-api";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import QRScanner from "@/components/event/QRScanner";
import type { Guest } from "@shared/eventflow";
import { eventGuests } from "@shared/eventflow";
import { classLabel } from "@shared/registration";
import { sortGuests, type GuestSortField } from "@/lib/guest-sort";
import "@/styles/event-mobile.css";

type CheckInResult = { guest: Guest; alreadyCheckedIn: boolean };
type CheckInPayload = { token: string } | { guestId: string };

function messageForError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "未能完成簽到。請確認此 QR 屬於目前活動後重試。";
}

function invitationFromScan(raw: string) {
  try {
    const url = new URL(raw, window.location.origin);
    const params = new URLSearchParams(
      url.hash.startsWith("#") ? url.hash.slice(1) : ""
    );
    if (params.get("claim")) return null;
    return (
      params.get("invite") ??
      (!url.hash && !raw.includes("://") && !raw.includes("=")
        ? raw.trim()
        : null)
    );
  } catch {
    const fragment = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : raw;
    const params = new URLSearchParams(fragment);
    if (params.get("claim")) return null;
    return (
      params.get("invite") ??
      (raw.includes("#") || raw.includes("=") ? null : raw.trim())
    );
  }
}

export default function CheckInDesk() {
  const {
    session,
    state,
    loading,
    error: workspaceError,
    reload,
  } = useWorkspace();
  const [mode, setMode] = useState<"token" | "guest">("token");
  const [value, setValue] = useState("");
  const [guestQuery, setGuestQuery] = useState("");
  const [guestSortBy, setGuestSortBy] = useState<GuestSortField>("name");
  const [selectedGuest, setSelectedGuest] = useState<Guest | null>(null);
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const keyRef = useRef(idempotencyKey());
  const lastSignatureRef = useRef<string | null>(null);

  const authorized =
    state &&
    ["owner", "admin", "project_manager", "guest_manager", "checkin"].includes(
      state.role
    );
  const guestMatches = state
    ? sortGuests(
        eventGuests(state.event, state.guests).filter(guest => {
          const query = guestQuery.trim().toLocaleLowerCase();
          if (!query) return true;
          return [
            guest.name,
            guest.group,
            guest.ticket,
            guest.phone,
            guest.chapter || "",
            guest.invitedBy || "",
            classLabel(guest),
          ].some(field => field.toLocaleLowerCase().includes(query));
        }),
        guestSortBy
      ).slice(0, 8)
    : [];

  const executeCheckIn = async (payload: CheckInPayload) => {
    if (!state || submitting) return;
    const signature = JSON.stringify(payload);
    if (lastSignatureRef.current && lastSignatureRef.current !== signature)
      keyRef.current = idempotencyKey();
    lastSignatureRef.current = signature;

    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await api<CheckInResult>(
        `/events/${state.event.id}/checkin`,
        "POST",
        payload,
        keyRef.current
      );
      setResult(response);
      void reload();
    } catch (checkInError) {
      // Keep the same idempotency key for a safe retry of the same staff action.
      setError(messageForError(checkInError));
    } finally {
      setSubmitting(false);
    }
  };

  const submitManual = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError(
        mode === "token"
          ? "請輸入嘉賓邀請 token 或完整連結。"
          : "請輸入嘉賓 ID。"
      );
      return;
    }
    if (mode === "guest" && !selectedGuest) {
      setError("請先從搜尋結果選擇一位嘉賓。");
      return;
    }
    if (mode === "guest" && !manualConfirmed) {
      setError("手動簽到前，請確認已與嘉賓核對身份。");
      return;
    }
    const token = invitationFromScan(trimmed);
    if (mode === "token" && !token) {
      setError("此連結不是嘉賓邀請。消費憑證不能用於簽到。");
      return;
    }
    void executeCheckIn(
      mode === "token" ? { token: token! } : { guestId: selectedGuest!.id }
    );
  };

  const scanInvitation = async (raw: string) => {
    const token = invitationFromScan(raw);
    if (!token)
      throw new Error(
        "此 QR 是消費憑證或無效連結，不能作簽到。請掃描嘉賓邀請 QR。"
      );
    setMode("token");
    setValue(token);
    setShowScanner(false);
    await executeCheckIn({ token });
  };

  const resetDesk = () => {
    setValue("");
    setGuestQuery("");
    setSelectedGuest(null);
    setManualConfirmed(false);
    setError(null);
    setResult(null);
    lastSignatureRef.current = null;
    keyRef.current = idempotencyKey();
  };

  if (loading) {
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status">
          <LoaderCircle className="event-mobile-spin" /> 正在讀取簽到工作區…
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
  if (!session || !state || !authorized) {
    return (
      <main className="event-mobile">
        <section className="event-mobile-card event-mobile-status event-mobile-status--error">
          <CircleAlert />
          <h1>沒有簽到權限</h1>
          <p>請以大會管理員或獲授權的現場簽到帳戶登入。</p>
        </section>
      </main>
    );
  }

  const table = result?.guest.tableId
    ? state.tables.find(item => item.id === result.guest.tableId)
    : null;

  return (
    <main className="event-mobile event-mobile--checkin">
      <header
        className="event-mobile-hero"
        style={
          {
            "--event-accent": state.event.brand.color ?? "#c89538",
          } as React.CSSProperties
        }
      >
        <span className="event-mobile-eyebrow">
          <ClipboardCheck size={14} /> 現場簽到工作台
        </span>
        <h1>{state.event.name}</h1>
        <p>掃描嘉賓邀請 QR，或經身份核對後以嘉賓 ID 手動簽到。</p>
      </header>

      {result ? (
        <section
          className={`event-mobile-card checkin-result ${result.alreadyCheckedIn ? "checkin-result--duplicate" : ""}`}
          aria-live="polite"
        >
          <div className="checkin-result__top">
            {result.alreadyCheckedIn ? (
              <Users size={25} />
            ) : (
              <CheckCircle2 size={25} />
            )}
            <div>
              <span>{result.alreadyCheckedIn ? "重複簽到" : "簽到完成"}</span>
              <h2>{result.guest.name}</h2>
            </div>
          </div>
          <dl className="checkin-result__details">
            <div>
              <dt>嘉賓票號</dt>
              <dd>{result.guest.ticket}</dd>
            </div>
            <div>
              <dt>枱號</dt>
              <dd>
                {table
                  ? `${String(table.number).padStart(2, "0")} 號枱`
                  : "尚未安排"}
              </dd>
            </div>
            <div>
              <dt>座位</dt>
              <dd>
                {result.guest.seat ? `${result.guest.seat} 號` : "尚未安排"}
              </dd>
            </div>
            <div>
              <dt>分會</dt>
              <dd>{result.guest.chapter || "未提供"}</dd>
            </div>
            <div>
              <dt>邀請人</dt>
              <dd>{result.guest.invitedBy || "未提供"}</dd>
            </div>
            <div>
              <dt>班別</dt>
              <dd>{classLabel(result.guest) || "未提供"}</dd>
            </div>
          </dl>
          <p className="event-mobile-help">
            {result.alreadyCheckedIn
              ? "此嘉賓已於較早前完成簽到，沒有再次計入到場人數。"
              : "到場狀態已由伺服器更新。"}
          </p>
          <button
            type="button"
            className="event-mobile-primary"
            onClick={resetDesk}
          >
            <UserCheck size={18} /> 為下一位嘉賓簽到
          </button>
        </section>
      ) : (
        <section className="event-mobile-card checkin-form">
          <div
            className="checkin-form__tabs"
            role="tablist"
            aria-label="簽到方式"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "token"}
              className={mode === "token" ? "is-active" : ""}
              onClick={() => {
                setMode("token");
                resetDesk();
              }}
            >
              嘉賓邀請 QR
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "guest"}
              className={mode === "guest" ? "is-active" : ""}
              onClick={() => {
                setMode("guest");
                resetDesk();
              }}
            >
              搜尋嘉賓
            </button>
          </div>

          {mode === "token" && (
            <>
              <button
                type="button"
                className="event-mobile-primary"
                onClick={() => setShowScanner(value => !value)}
              >
                <ScanLine size={18} />
                {showScanner ? "收起掃碼器" : "開啟相機掃描邀請 QR"}
              </button>
              {showScanner && (
                <QRScanner
                  onDetect={scanInvitation}
                  title="掃描嘉賓邀請 QR"
                  description="相機需要你手動開啟。消費憑證 QR 不可用於簽到。"
                  disabled={submitting}
                />
              )}
            </>
          )}

          <form onSubmit={submitManual} className="checkin-form__manual">
            <label className="event-mobile-label" htmlFor="checkin-manual">
              {mode === "token"
                ? "或貼上嘉賓邀請完整連結／token"
                : "搜尋姓名、分會、邀請人、班別、票號或電話"}
            </label>
            <input
              id="checkin-manual"
              autoComplete="off"
              value={mode === "token" ? value : guestQuery}
              onChange={event => {
                if (mode === "token") setValue(event.target.value);
                else {
                  setGuestQuery(event.target.value);
                  setSelectedGuest(null);
                  setManualConfirmed(false);
                }
              }}
              placeholder={
                mode === "token"
                  ? "貼上邀請連結或 token"
                  : "輸入姓名、分會、邀請人、班別、票號或電話"
              }
              disabled={submitting}
            />
            {mode === "guest" && (
              <label className="event-mobile-label" htmlFor="checkin-sort">
                排序
                <select
                  id="checkin-sort"
                  value={guestSortBy}
                  onChange={event => setGuestSortBy(event.target.value as GuestSortField)}
                  disabled={submitting}
                >
                  <option value="name">姓名</option>
                  <option value="phone">電話</option>
                </select>
              </label>
            )}
            {mode === "guest" && selectedGuest && (
              <p className="event-mobile-selected-guest">
                已選擇：<strong>{selectedGuest.name}</strong>
                {selectedGuest.group && ` · ${selectedGuest.group}`}
                {selectedGuest.ticket && ` · ${selectedGuest.ticket}`}
                {` · 分會：${selectedGuest.chapter || "未提供"} · 邀請人：${selectedGuest.invitedBy || "未提供"} · 班別：${classLabel(selectedGuest) || "未提供"}`}
                {selectedGuest.rosterClaimBlocked && " · 需人工核對"}
              </p>
            )}
            {mode === "guest" && guestMatches.length > 0 && !selectedGuest && (
              <div
                className="event-mobile-search-results"
                aria-label="嘉賓搜尋結果"
              >
                {guestMatches.map(guest => (
                  <button
                    type="button"
                    key={guest.id}
                    disabled={submitting}
                    onClick={() => {
                      setSelectedGuest(guest);
                      setGuestQuery(guest.name);
                      setError(null);
                    }}
                  >
                    <Search size={15} />
                    <span>
                      <strong>{guest.name}</strong>
                      <small>
                        {guest.group || guest.ticket} · 分會：
                        {guest.chapter || "未提供"} · 邀請人：
                        {guest.invitedBy || "未提供"} · 班別：
                        {classLabel(guest) || "未提供"}
                        {guest.rosterClaimBlocked && " · 需人工核對"}
                      </small>
                    </span>
                    <em>{guest.checkedInAt ? "已到場" : "未簽到"}</em>
                  </button>
                ))}
              </div>
            )}
            {mode === "guest" && (
              <label className="event-mobile-check event-mobile-check--consent">
                <input
                  type="checkbox"
                  checked={manualConfirmed}
                  onChange={event => setManualConfirmed(event.target.checked)}
                  disabled={submitting}
                />
                <span>我已與嘉賓核對身份，確認要為此 ID 簽到。</span>
              </label>
            )}
            {error && (
              <p
                className="event-mobile-alert event-mobile-alert--error"
                role="alert"
              >
                <CircleAlert size={17} /> {error}
              </p>
            )}
            <button
              type="submit"
              className="event-mobile-primary"
              disabled={
                submitting ||
                (mode === "token"
                  ? !value.trim()
                  : !selectedGuest || !manualConfirmed)
              }
            >
              {submitting ? (
                <LoaderCircle className="event-mobile-spin" size={18} />
              ) : (
                <UserCheck size={18} />
              )}
              {submitting ? "正在簽到…" : "確認簽到"}
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
