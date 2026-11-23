import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { api, idempotencyKey } from "@/lib/eventflow-api";
import { eventDateFromFields } from "@/lib/event-date";
import { startLogin } from "@/const";
import type { EventInfo, EventProgram } from "@shared/eventflow";
import { GOOGLE_PRODUCTION_ORIGIN } from "@shared/google-login";
import "@/styles/access-management.css";
import ParticipantLoginButton from "./ParticipantLoginButton";

export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { session, state, loading, error, reload } = useWorkspace();
  if (loading) return <StatusPane text="正在驗證登入及讀取活動…" />;
  if (!session)
    return (
      <StatusPane
        text={error || "工作人員請使用 Google 登入；活動參與者可使用臨時帳戶。"}
        action={<GoogleLoginButton />}
      />
    );
  let pending = "";
  try {
    pending = sessionStorage.getItem("eventflow-pending-staff-invite") || "";
  } catch {}
  if (pending) return <JoinWorkspace />;
  if (!session.events.length)
    return session.canCreateEvents ? (
      <><PendingOwnership /><CreateFirstEvent /></>
    ) : (
      <WaitingForAccess />
    );
  if (!state)
    return (
      <><PendingOwnership /><StatusPane
        text={error || "正在載入活動資料…"}
        action={
          error && (
            <button className="button" onClick={() => void reload()}>
              重新讀取
            </button>
          )
        }
      /></>
    );
  return <><PendingOwnership />{children}</>;
}

function PendingOwnership() {
  const { session, refreshSession, setEventId } = useWorkspace();
  const [items, setItems] = useState<{ eventId: string; name: string; date: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  useEffect(() => {
    if (session?.user.systemRole !== "owner") return;
    let active = true;
    void api<typeof items>("/system/pending-ownership").then(
      data => { if (active) setItems(data); },
      () => { if (active) setError("未能讀取待指派清單，請刷新頁面重試。"); }
    );
    return () => { active = false; };
  }, [session?.user.systemRole]);
  if (session?.user.systemRole !== "owner" || (!items.length && !error)) return null;
  return (
    <section className="mvp-gate" aria-label="待指派活動">
      <h2>待指派</h2>
      {items.map(item => <div key={item.eventId}>
        <p>{item.name} · {item.date}</p>
        <p>指派給目前登入帳戶：{session.user.email || session.user.name}</p>
        <button type="button" className="button button-dark" disabled={busy} onClick={async () => {
          if (busyRef.current || !window.confirm(`確定將「${item.name}」及其組織指派給目前登入帳戶 ${session.user.email || session.user.name}？`)) return;
          busyRef.current = true;
          setBusy(true);
          setError("");
          try {
            const result = await api<{eventId: string}>("/system/pending-ownership/claim", "POST", {});
            setEventId(result.eventId);
            setItems([]);
            await refreshSession();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "指派未完成，請重試。");
          } finally { busyRef.current = false; setBusy(false); }
        }}>{busy ? "指派中…" : "指派給目前登入帳戶"}</button>
      </div>)}
      {error && <p className="mvp-error" role="alert">{error}</p>}
    </section>
  );
}

function StatusPane({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <main className="mvp-gate">
      <img src="/eventflow-mark.svg" width={52} alt="EventFlow" />
      <h1>EventFlow 活動工作台</h1>
      <p role="status">{text}</p>
      {action}
    </main>
  );
}

function authErrorMessage() {
  const code = new URLSearchParams(window.location.search).get("authError");
  if (!code) return "";
  const messages: Record<string, string> = {
    configuration: "Google 登入尚未設定，請聯絡系統管理員。",
    state_invalid: "登入驗證已失效，請重新使用 Google 登入。",
    token_invalid: "Google 身份驗證未能完成，請重新登入。",
    storage_error: "登入帳戶未能儲存，請稍後重試或聯絡系統管理員。",
    top_level_required: "請在正式網站的獨立分頁重新使用 Google 登入。",
    google_not_configured: "Google 登入尚未設定，請聯絡系統管理員。",
    google_cancelled: "你已取消 Google 登入，請重新嘗試。",
    google_denied: "Google 登入授權未獲允許，請重新嘗試。",
    access_denied: "Google 登入授權未獲允許，請重新嘗試。",
    google_invalid_state: "登入驗證已失效，請重新使用 Google 登入。",
    invalid_state: "登入驗證已失效，請重新使用 Google 登入。",
    google_email_unverified: "請使用已驗證電郵的 Google 帳戶登入。",
    unverified_email: "請使用已驗證電郵的 Google 帳戶登入。",
    google_failed: "Google 登入未能完成，請重新嘗試。",
    google_login_failed: "Google 登入未能完成，請重新嘗試。",
    oauth_failed: "Google 登入未能完成，請重新嘗試。",
  };
  return messages[code] || "登入未能完成，請重新使用 Google 登入。";
}

/** Shared by the workspace, invitation and standalone access pages. */
export function GoogleLoginButton({ returnTo }: { returnTo?: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const loginError = authErrorMessage();

  useEffect(() => {
    const controller = new AbortController();
    setConfigured(null);
    setStatusError("");
    void (async () => {
      try {
        const response = await fetch("/api/auth/google/status", {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error("暫時無法確認 Google 登入設定，請重試。");
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== "object" ||
          !("configured" in data) ||
          typeof data.configured !== "boolean"
        )
          throw new Error("Google 登入狀態回應不正確，請重試。");
        if (!controller.signal.aborted) setConfigured(data.configured);
      } catch (reason) {
        if (!controller.signal.aborted)
          setStatusError(
            reason instanceof Error
              ? reason.message
              : "未能讀取 Google 登入狀態。"
          );
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="access-login">
      <button
        type="button"
        className="button button-dark"
        disabled={configured !== true || starting}
        onClick={() => {
          if (configured !== true || startingRef.current) return;
          startingRef.current = true;
          setStarting(true);
          try {
            startLogin(returnTo);
          } catch (reason) {
            startingRef.current = false;
            setStarting(false);
            setStatusError(
              reason instanceof Error
                ? reason.message
                : "未能開始 Google 登入。"
            );
          }
        }}
      >
        {starting ? "正在前往 Google…" : "使用 Google 帳戶登入"}
      </button>
      {import.meta.env.PROD && window.location.origin !== GOOGLE_PRODUCTION_ORIGIN && (
        <small>Google 登入會前往 bp.jengevents.com，完成後將留在正式網站。</small>
      )}
      {configured === null && !statusError && (
        <small role="status">正在確認 Google 登入設定…</small>
      )}
      {configured === false && (
        <p role="status">
          Google 登入尚未設定，請聯絡系統管理員完成設定後再登入。
        </p>
      )}
      {statusError && (
        <>
          <p className="mvp-error" role="alert">
            {statusError}
          </p>
          <button
            type="button"
            className="button button-white"
            disabled={starting}
            onClick={() => setAttempt(value => value + 1)}
          >
            重新確認登入設定
          </button>
        </>
      )}
      {loginError && (
        <p className="mvp-error" role="alert">
          {loginError}
        </p>
      )}
      <small>
        以 Google 登入後自動建立待授權帳戶；毋須另外設定電郵或密碼。
      </small>
      <ParticipantLoginButton />
    </div>
  );
}

export function WorkspaceAccountActions({
  disabled = false,
  showAccessLink = true,
}: {
  disabled?: boolean;
  showAccessLink?: boolean;
}) {
  const { session, refreshSession, error } = useWorkspace();
  const { logout } = useAuth();
  const [busy, setBusy] = useState<"refresh" | "logout" | null>(null);
  const [actionError, setActionError] = useState("");
  const busyRef = useRef(false);
  if (!session) return null;
  const roleName =
    session.user.systemRole === "owner"
      ? "系統擁有者"
      : session.user.systemRole === "admin"
        ? "系統管理員"
        : "一般帳戶";
  const run = async (action: "refresh" | "logout") => {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(action);
    setActionError("");
    try {
      if (action === "logout") {
        await logout();
        await refreshSession();
        window.location.assign("/");
      } else {
        await refreshSession();
      }
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "帳戶操作未能完成。"
      );
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  return (
    <div className="access-account">
      <p>
        <strong>
          {session.user.name || session.user.email || "已登入用戶"}
        </strong>{" "}
        · {roleName}
        {session.user.email && <small>{session.user.email}</small>}
      </p>
      <div className="mvp-inline-actions">
        {showAccessLink && session.canManageAccess && (
          <Link className="button button-dark" href="/access">
            帳戶授權管理
          </Link>
        )}
        <button
          type="button"
          className="button button-white"
          disabled={disabled || busy !== null}
          onClick={() => void run("refresh")}
        >
          {busy === "refresh" ? "刷新中…" : "刷新授權"}
        </button>
        <button
          type="button"
          className="button button-white"
          disabled={disabled || busy !== null}
          onClick={() => void run("logout")}
        >
          {busy === "logout" ? "登出中…" : "登出"}
        </button>
      </div>
      {(actionError || error) && (
        <p role="alert" className="mvp-error">
          {actionError || error}
        </p>
      )}
    </div>
  );
}

export function WaitingForAccess() {
  const { session } = useWorkspace();
  return (
    <StatusPane
      text={
        session
          ? "你已登入，目前沒有可使用的活動。請聯絡管理員為此帳戶授予活動角色，然後刷新授權。"
          : "請使用 Google 帳戶登入，並等待管理員授權。"
      }
      action={
        session ? (
          <>
            <span className="access-badge">
              {session.canManageAccess ? "暫無活動" : "Google 登入待授權"}
            </span>
            <WorkspaceAccountActions />
          </>
        ) : (
          <GoogleLoginButton />
        )
      }
    />
  );
}

const emptyProgram: EventProgram = {
  titleEn: "",
  organizationEn: "",
  venueAddress: "",
  receptionTime: "",
  seatingTime: "",
};
const eliteCeremonyPreset = {
  organization: "示例機構",
  brandName: "示例機構",
  name: "示例活動",
  date: "2026-01-01T18:30",
  venue: "Sample Venue 示例地址（炮台山站A出口）",
  program: {
    titleEn: "Sample Event",
    organizationEn: "Sample Organization",
    venueAddress: "Sample Venue 示例地址（炮台山站A出口）",
    receptionTime: "18:30 恭候",
    seatingTime: "19:30 入席",
  },
} as const;

export function CreateFirstEvent() {
  const { session, refreshSession, setEventId } = useWorkspace();
  const [org, setOrg] = useState("");
  const [brandName, setBrandName] = useState("");
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [mode, setMode] = useState<EventInfo["mode"]>("attendance");
  const [program, setProgram] = useState<EventProgram>(emptyProgram);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [organizationId, setOrganizationId] = useState(
    session?.organizations[0]?.id || ""
  );
  const [key] = useState(idempotencyKey);

  const updateProgram = (field: keyof EventProgram, value: string) => {
    setProgram(current => ({ ...current, [field]: value }));
  };

  if (!session?.canCreateEvents) return <WaitingForAccess />;

  return (
    <main className="mvp-gate">
      <img src="/eventflow-mark.svg" width={52} alt="EventFlow" />
      <h1>建立第一場活動</h1>
      <p>使用真實資料開始；活動、嘉賓及簽到紀錄均會獨立保存。</p>
      <WorkspaceAccountActions disabled={busy} />
      <button
        type="button"
        className="button button-white"
        disabled={busy}
        onClick={() => {
          setOrg(eliteCeremonyPreset.organization);
          setBrandName(eliteCeremonyPreset.brandName);
          setName(eliteCeremonyPreset.name);
          setDate(eliteCeremonyPreset.date.slice(0, 10));
          setTime(eliteCeremonyPreset.date.slice(11));
          setVenue(eliteCeremonyPreset.venue);
          setMode("attendance");
          setProgram(eliteCeremonyPreset.program);
        }}
      >
        載入示例活動資料
      </button>
      <form
        onSubmit={async event => {
          event.preventDefault();
          if (busyRef.current || !session.canCreateEvents) return;
          const eventDate = eventDateFromFields({ date, time });
          if (!eventDate) {
            setError("請填寫有效日期及時間；時間可留空待定。");
            return;
          }
          busyRef.current = true;
          setBusy(true);
          setError("");
          try {
            let tenantId = organizationId;
            if (!tenantId) {
              const created = await api<{ id: string }>(
                "/organizations",
                "POST",
                { name: org.trim() },
                key
              );
              tenantId = created.id;
              setOrganizationId(tenantId);
            }
            const created = await api<EventInfo>(
              "/events",
              "POST",
              {
                tenantId,
                name: name.trim(),
                date: eventDate,
                venue: venue.trim(),
                brandName: brandName.trim() || undefined,
                mode,
                program: mode === "attendance" ? program : emptyProgram,
              },
              key
            );
            setEventId(created.id);
            await refreshSession();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "活動未能建立");
          } finally {
            busyRef.current = false;
            setBusy(false);
          }
        }}
      >
        {!organizationId && (
          <label>
            大會／組織名稱
            <input
              required
              maxLength={100}
              value={org}
              onChange={event => setOrg(event.target.value)}
              placeholder="例如：示例機構"
            />
          </label>
        )}
        <label>
          活動類型
          <select
            value={mode}
            onChange={event => setMode(event.target.value as EventInfo["mode"])}
          >
            <option value="attendance">簽到與圍枱典禮</option>
            <option value="full">完整活動（商戶、消費及抽獎）</option>
          </select>
        </label>
        <label>
          活動名稱
          <input
            required
            maxLength={150}
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="例如：示例活動"
          />
        </label>
        <label>
          白牌品牌名稱（選填）
          <input
            maxLength={120}
            value={brandName}
            onChange={event => setBrandName(event.target.value)}
            placeholder="例如：示例機構"
          />
        </label>
        <label>
          活動日期
          <input
            type="date"
            required
            value={date}
            onChange={event => setDate(event.target.value)}
          />
        </label>
        <label>
          開始時間（瀏覽器時區；留空表示待定）
          <input
            type="time"
            step="0.001"
            value={time}
            onChange={event => setTime(event.target.value)}
          />
        </label>
        <label>
          場地（選填，留空表示待定）
          <input
            maxLength={300}
            value={venue}
            onChange={event => setVenue(event.target.value)}
            placeholder="例如：Sample Venue"
          />
        </label>
        {mode === "attendance" && (
          <fieldset className="mvp-gate-fieldset">
            <legend>典禮資料（可稍後在設定頁修改）</legend>
            <label>
              英文活動名稱
              <input
                maxLength={200}
                value={program.titleEn}
                onChange={event => updateProgram("titleEn", event.target.value)}
              />
            </label>
            <label>
              英文組織名稱
              <input
                maxLength={200}
                value={program.organizationEn}
                onChange={event =>
                  updateProgram("organizationEn", event.target.value)
                }
              />
            </label>
            <label>
              場地地址
              <input
                maxLength={400}
                value={program.venueAddress}
                onChange={event =>
                  updateProgram("venueAddress", event.target.value)
                }
              />
            </label>
            <div className="mvp-gate-two-col">
              <label>
                恭候時間
                <input
                  maxLength={80}
                  value={program.receptionTime}
                  onChange={event =>
                    updateProgram("receptionTime", event.target.value)
                  }
                  placeholder="例如：18:30 恭候"
                />
              </label>
              <label>
                入席時間
                <input
                  maxLength={80}
                  value={program.seatingTime}
                  onChange={event =>
                    updateProgram("seatingTime", event.target.value)
                  }
                  placeholder="例如：19:30 入席"
                />
              </label>
            </div>
          </fieldset>
        )}
        <button
          className="button button-dark"
          disabled={
            busy ||
            !name.trim() ||
            !date ||
            (!organizationId && !org.trim())
          }
        >
          {busy ? "建立中…" : "建立活動"}
        </button>
        {error && (
          <p role="alert" className="mvp-error">
            {error}
          </p>
        )}
      </form>
      <small>
        簽到典禮模式只保留嘉賓、圍枱、簽到與名單匯出，後端亦會停用商戶、消費與抽獎。
      </small>
    </main>
  );
}

export function JoinWorkspace() {
  const {
    session,
    loading,
    refreshSession,
    setEventId,
    error: sessionError,
  } = useWorkspace();
  const [token] = useState(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const value = hash.get("invite");
    try {
      if (value) {
        sessionStorage.setItem("eventflow-pending-staff-invite", value);
        history.replaceState(null, "", location.pathname);
      }
      return (
        value || sessionStorage.getItem("eventflow-pending-staff-invite") || ""
      );
    } catch {
      return value || "";
    }
  });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [key] = useState(idempotencyKey);
  if (loading) return <StatusPane text="正在驗證登入…" />;
  if (!session)
    return (
      <StatusPane
        text={
          sessionError ||
          "請使用 Google 帳戶登入，登入後再確認是否接受工作人員邀請。"
        }
        action={<GoogleLoginButton />}
      />
    );
  return (
    <StatusPane
      text={
        token
          ? "你已登入，請確認加入此活動的工作人員角色。"
          : "此邀請連結沒有有效憑證。"
      }
      action={
        <>
          <button
            type="button"
            className="button button-dark"
            disabled={busy || !token}
            onClick={async () => {
              if (busyRef.current || !token) return;
              busyRef.current = true;
              setBusy(true);
              setError("");
              try {
                const result = await api<{ eventId: string }>(
                  "/invites/accept",
                  "POST",
                  { token },
                  key
                );
                try {
                  sessionStorage.removeItem("eventflow-pending-staff-invite");
                } catch {}
                setEventId(result.eventId);
                await refreshSession();
                location.assign("/");
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : "邀請未能接受"
                );
              } finally {
                busyRef.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? "加入中…" : "接受角色邀請"}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              try {
                sessionStorage.removeItem("eventflow-pending-staff-invite");
              } catch {}
              location.assign("/");
            }}
          >
            取消／返回工作台
          </button>
          {error && <p role="alert">{error}</p>}
        </>
      }
    />
  );
}
