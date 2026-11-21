import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";
import type { AccessDirectory, AccessUser, Role } from "@shared/eventflow";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { api, idempotencyKey } from "@/lib/eventflow-api";
import {
  GoogleLoginButton,
  WorkspaceAccountActions,
} from "@/components/event/WorkspaceGate";
import "@/styles/access-management.css";

const roleNames: Record<Role, string> = {
  owner: "活動擁有者",
  admin: "活動管理員",
  project_manager: "項目管理員",
  guest_manager: "嘉賓管理員",
  checkin: "簽到工作人員",
  draw: "抽獎工作人員",
  merchant: "商戶工作人員",
};
const systemRoleNames: Record<AccessUser["systemRole"], string> = {
  owner: "系統擁有者",
  admin: "系統管理員",
  user: "一般帳戶",
};
// Owner identities are never granted from this page.
const assignableRoles: Role[] = [
  "admin",
  "project_manager",
  "guest_manager",
  "checkin",
  "draw",
  "merchant",
];
type ManagedEvent = AccessDirectory["events"][number];
type Mutation = (
  action: string,
  message: string,
  path: string,
  method: "POST" | "PATCH",
  body: unknown
) => Promise<boolean>;

function messageFrom(reason: unknown) {
  return reason instanceof Error ? reason.message : "操作未能完成，請重試。";
}
function isPending(user: AccessUser) {
  return (
    user.systemRole === "user" &&
    !user.assignments.some(assignment => assignment.active)
  );
}

export function AccessManagement() {
  const {
    session,
    loading,
    error: sessionError,
    refreshSession,
  } = useWorkspace();
  const [directory, setDirectory] = useState<AccessDirectory | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "pending">("all");
  const lock = useRef(false);
  const sequence = useRef(0);
  const mutationKeys = useRef(new Map<string, string>());
  const userId = session?.user.id;
  const canManageAccess = session?.canManageAccess === true;

  const reloadDirectory = useCallback(async () => {
    if (!userId || !canManageAccess) return;
    const request = ++sequence.current;
    setDirectoryLoading(true);
    try {
      const next = await api<AccessDirectory>("/system/access");
      if (sequence.current === request) setDirectory(next);
    } finally {
      if (sequence.current === request) setDirectoryLoading(false);
    }
  }, [userId, canManageAccess]);

  useEffect(() => {
    setDirectory(null);
    setError("");
    setNotice("");
    if (canManageAccess && userId)
      void reloadDirectory().catch(reason => setError(messageFrom(reason)));
    else setDirectoryLoading(false);
    return () => {
      sequence.current++;
    };
  }, [reloadDirectory, canManageAccess, userId]);

  const mutate: Mutation = async (action, message, path, method, body) => {
    if (lock.current || !canManageAccess) return false;
    lock.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    let committed = false;
    const fingerprint = `${method}:${path}:${JSON.stringify(body)}`;
    try {
      let key = mutationKeys.current.get(fingerprint);
      if (!key) {
        key = idempotencyKey();
        mutationKeys.current.set(fingerprint, key);
      }
      await api(path, method, body, key);
      committed = true;
      mutationKeys.current.delete(fingerprint);
      await Promise.all([reloadDirectory(), refreshSession()]);
      setNotice(message);
      return true;
    } catch (reason) {
      setError(
        `${committed ? "授權變更已儲存，但重新讀取失敗：" : ""}${messageFrom(reason)}`
      );
      return committed;
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (lock.current || directoryLoading) return;
    lock.current = true;
    setBusy("refresh");
    setError("");
    setNotice("");
    try {
      await Promise.all([reloadDirectory(), refreshSession()]);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const disabled = busy !== null || directoryLoading || loading;
  const query = search.trim().toLocaleLowerCase();
  const visibleUsers =
    directory?.users.filter(user => {
      if (filter === "pending" && !isPending(user)) return false;
      const text = [
        user.name,
        user.email,
        systemRoleNames[user.systemRole],
        isPending(user) ? "Google 登入待授權" : "",
        ...user.assignments.map(assignment => roleNames[assignment.role]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return !query || text.includes(query);
    }) ?? [];
  const owners =
    directory?.users.filter(user => user.systemRole === "owner") ?? [];

  return (
    <main className="access-management">
      <header className="access-header">
        <Link href="/" className="access-brand">
          <img src="/eventflow-mark.svg" width={36} height={36} alt="" />
          <span>
            EventFlow<span className="access-brand-subtitle">活動工作台</span>
          </span>
        </Link>
        <Link href="/" className="button button-white">
          返回工作台
        </Link>
      </header>
      <div className="access-content">
        <div className="access-title">
          <span className="access-kicker">ACCOUNTS & ACCESS</span>
          <h1>帳戶授權管理</h1>
          <p>搜尋已登入的帳戶，授予或撤回你可管理的活動角色。</p>
        </div>
        {loading && !session ? (
          <section className="access-panel access-empty" role="status">
            正在驗證登入狀態…
          </section>
        ) : !session ? (
          <section className="access-panel access-empty">
            <h2>請先使用 Google 登入</h2>
            <p>
              新帳戶登入後自動進入待授權狀態。此頁只供具備授權管理權限的帳戶使用。
            </p>
            {sessionError && (
              <p role="alert" className="mvp-error">
                {sessionError}
              </p>
            )}
            <GoogleLoginButton returnTo="/access" />
          </section>
        ) : !canManageAccess ? (
          <section className="access-panel access-empty">
            <span className="access-badge">Google 登入待授權</span>
            <h2>你目前沒有帳戶授權管理權限</h2>
            <p>
              請聯絡系統擁有者或活動管理員，為你的 Google
              帳戶授予適當角色。已有活動角色的帳戶可返回工作台。
            </p>
            <WorkspaceAccountActions showAccessLink={false} />
          </section>
        ) : (
          <>
            <section className="access-panel access-session">
              <WorkspaceAccountActions
                disabled={disabled}
                showAccessLink={false}
              />
              <button
                type="button"
                className="button button-white"
                disabled={disabled}
                onClick={() => void refresh()}
              >
                {busy === "refresh" || directoryLoading
                  ? "讀取中…"
                  : "重新讀取帳戶清單"}
              </button>
            </section>
            <section
              className="access-panel access-owner-note"
              aria-labelledby="access-owner-title"
            >
              <h2 id="access-owner-title">系統擁有者</h2>
              {owners.length > 0 && (
                <ul>
                  {owners.map(owner => (
                    <li key={owner.id}>
                      <strong>{owner.name || "已註冊系統擁有者"}</strong>
                      {owner.email && <span>{owner.email}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <p>
                系統擁有者只由指定的已驗證 Google
                帳戶登入後，經後端確認。尚未登入的擁有者不會顯示在清單；此頁不能授予或移除系統擁有者身份。
              </p>
              <p>
                {directory?.canGrantSystemAdmin
                  ? "你可授予或撤回系統管理員；此權限與個別活動角色獨立。"
                  : "只有系統擁有者可授予或撤回系統管理員；你只能管理後端提供的可授權活動。"}
              </p>
            </section>
            <div className="access-feedback" aria-live="polite">
              {(error || sessionError) && (
                <p role="alert" className="access-error">
                  {error || sessionError}
                </p>
              )}
              {notice && (
                <p role="status" className="access-success">
                  {notice}
                </p>
              )}
            </div>
            <section
              className="access-panel access-directory"
              aria-labelledby="access-directory-title"
              aria-busy={directoryLoading}
            >
              <div className="access-directory-heading">
                <div>
                  <h2 id="access-directory-title">已登入帳戶</h2>
                  <p>
                    待授權：一般帳戶且沒有清單內的啟用活動角色。只列出後端允許你管理的活動。
                  </p>
                </div>
                {directory && (
                  <span className="access-badge">
                    {directory.users.filter(isPending).length} 個待授權
                  </span>
                )}
              </div>
              <div className="access-toolbar">
                <label htmlFor="access-search">
                  搜尋姓名、電郵或角色
                  <input
                    id="access-search"
                    type="search"
                    placeholder="搜尋待授權的 Google 帳戶"
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                  />
                </label>
                <label htmlFor="access-filter">
                  帳戶篩選
                  <select
                    id="access-filter"
                    value={filter}
                    onChange={event =>
                      setFilter(event.target.value as "all" | "pending")
                    }
                  >
                    <option value="all">全部帳戶</option>
                    <option value="pending">Google 登入待授權</option>
                  </select>
                </label>
              </div>
              {!directory && directoryLoading ? (
                <div className="access-empty" role="status">
                  正在讀取帳戶及可授權活動…
                </div>
              ) : !directory ? (
                <div className="access-empty">
                  <h3>帳戶清單未能載入</h3>
                  <p>請查看上方錯誤訊息，並按「重新讀取帳戶清單」再試。</p>
                </div>
              ) : (
                <>
                  {directory.events.length === 0 && (
                    <p className="access-note">
                      目前沒有可授權活動。
                      {session.canCreateEvents
                        ? "你可返回工作台建立活動；系統帳戶權限仍可在此管理。"
                        : "請聯絡系統擁有者確認可管理的活動。"}
                    </p>
                  )}
                  <p className="access-results" role="status">
                    顯示 {visibleUsers.length} / {directory.users.length} 個帳戶
                  </p>
                  {visibleUsers.length === 0 ? (
                    <div className="access-empty">
                      <h3>
                        {directory.users.length === 0
                          ? "尚未有已登入帳戶"
                          : "沒有符合條件的帳戶"}
                      </h3>
                      <p>
                        {directory.users.length === 0
                          ? "請待授權的工作人員先使用 Google 登入，然後重新讀取帳戶清單。"
                          : "試試其他姓名、電郵或選擇全部帳戶。"}
                      </p>
                    </div>
                  ) : (
                    <div className="access-user-list">
                      {visibleUsers.map(user => (
                        <UserAccessCard
                          key={user.id}
                          user={user}
                          events={directory.events}
                          canGrantSystemAdmin={directory.canGrantSystemAdmin}
                          disabled={disabled}
                          busy={busy}
                          mutate={mutate}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function UserAccessCard({
  user,
  events,
  canGrantSystemAdmin,
  disabled,
  busy,
  mutate,
}: {
  user: AccessUser;
  events: ManagedEvent[];
  canGrantSystemAdmin: boolean;
  disabled: boolean;
  busy: string | null;
  mutate: Mutation;
}) {
  const formId = useId();
  const [eventId, setEventId] = useState("");
  const [role, setRole] = useState<Role>("checkin");
  const [merchantId, setMerchantId] = useState("");
  const [validationError, setValidationError] = useState("");
  const [confirmSystem, setConfirmSystem] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const selectedEvent = events.find(event => event.id === eventId);
  const existing = user.assignments.find(
    assignment => assignment.eventId === eventId && assignment.active
  );
  const ownerAssignment = existing?.role === "owner";
  const systemAction = `system:${user.id}`;
  const assignAction = `assign:${user.id}:${eventId}`;
  const canAssign =
    selectedEvent &&
    !ownerAssignment &&
    !(
      selectedEvent.mode === "attendance" &&
      (role === "draw" || role === "merchant")
    ) &&
    (role !== "merchant" ||
      selectedEvent.merchants.some(merchant => merchant.id === merchantId));

  const chooseEvent = (nextId: string) => {
    setEventId(nextId);
    const assignment = user.assignments.find(
      item => item.eventId === nextId && item.active
    );
    const nextEvent = events.find(event => event.id === nextId);
    const nextRole =
      assignment && assignableRoles.includes(assignment.role)
        ? assignment.role
        : "checkin";
    setRole(
      nextEvent?.mode === "attendance" &&
        (nextRole === "draw" || nextRole === "merchant")
        ? "checkin"
        : nextRole
    );
    setMerchantId(assignment?.merchantId || "");
    setValidationError("");
  };

  return (
    <article className="access-user">
      <div className="access-user-heading">
        <div>
          <h3>{user.name || user.email || "未提供姓名的帳戶"}</h3>
          <p>{user.email || "此帳戶未提供電郵"}</p>
        </div>
        <div className="access-badges">
          <span className="access-badge">
            {systemRoleNames[user.systemRole]}
          </span>
          {isPending(user) && (
            <span className="access-badge access-badge-pending">
              Google 登入待授權
            </span>
          )}
        </div>
      </div>
      <div className="access-system-role">
        <span>系統權限：{systemRoleNames[user.systemRole]}</span>
        {user.systemRole === "owner" ? (
          <small>系統擁有者由已驗證 Google 身份確認，不可在此更改。</small>
        ) : canGrantSystemAdmin ? (
          confirmSystem ? (
            <div className="access-confirm">
              <p>
                {user.systemRole === "admin"
                  ? "確認撤回此帳戶的系統管理員權限？活動角色會保留。"
                  : "確認授予此帳戶系統管理員權限？這不是單一活動的管理權限。"}
              </p>
              <div className="access-actions">
                <button
                  type="button"
                  className="button button-dark"
                  disabled={disabled}
                  onClick={async () => {
                    if (
                      await mutate(
                        systemAction,
                        user.systemRole === "admin"
                          ? "已撤回系統管理員權限。"
                          : "已授予系統管理員權限。",
                        `/system/access/${encodeURIComponent(String(user.id))}`,
                        "PATCH",
                        { systemAdmin: user.systemRole !== "admin" }
                      )
                    )
                      setConfirmSystem(false);
                  }}
                >
                  {busy === systemAction ? "儲存中…" : "確認變更"}
                </button>
                <button
                  type="button"
                  className="button button-white"
                  disabled={disabled}
                  onClick={() => setConfirmSystem(false)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="button button-white"
              disabled={disabled}
              onClick={() => setConfirmSystem(true)}
            >
              {user.systemRole === "admin"
                ? "撤回系統管理員"
                : "設為系統管理員"}
            </button>
          )
        ) : (
          <small>系統權限只可由系統擁有者更改。</small>
        )}
      </div>
      <div className="access-assignments">
        <h4>活動角色</h4>
        {user.assignments.length === 0 ? (
          <p className="access-muted">尚未授予活動角色。</p>
        ) : (
          <ul>
            {user.assignments.map(assignment => {
              const event = events.find(item => item.id === assignment.eventId);
              const merchant = event?.merchants.find(
                item => item.id === assignment.merchantId
              );
              const action = `revoke:${assignment.memberId}`;
              return (
                <li key={assignment.memberId}>
                  <div>
                    <strong>{event?.name || "活動（不在可管理清單）"}</strong>
                    <span>
                      {roleNames[assignment.role]}
                      {assignment.role === "merchant" &&
                        ` · ${merchant?.name || "商戶未列於清單"}`}{" "}
                      · {assignment.active ? "已啟用" : "已撤回"}
                    </span>
                  </div>
                  {assignment.active &&
                    event &&
                    assignment.role !== "owner" &&
                    (confirmRevoke === assignment.memberId ? (
                      <div className="access-confirm">
                        <p>確認撤回此活動角色？</p>
                        <div className="access-actions">
                          <button
                            type="button"
                            className="button access-button-danger"
                            disabled={disabled}
                            onClick={async () => {
                              if (
                                await mutate(
                                  action,
                                  "已撤回活動角色。",
                                  `/events/${encodeURIComponent(assignment.eventId)}/members/${encodeURIComponent(assignment.memberId)}`,
                                  "PATCH",
                                  { active: false }
                                )
                              )
                                setConfirmRevoke(null);
                            }}
                          >
                            {busy === action ? "撤回中…" : "確認撤回"}
                          </button>
                          <button
                            type="button"
                            className="button button-white"
                            disabled={disabled}
                            onClick={() => setConfirmRevoke(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="button button-white"
                        disabled={disabled}
                        onClick={() => setConfirmRevoke(assignment.memberId)}
                      >
                        撤回角色
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {events.length > 0 && (
        <form
          className="access-assignment-form"
          onSubmit={async event => {
            event.preventDefault();
            setValidationError("");
            if (disabled) return;
            if (!canAssign || !selectedEvent) {
              setValidationError(
                "請選擇可管理的活動、適用角色及商戶（如需要）。"
              );
              return;
            }
            await mutate(
              assignAction,
              existing ? "已更新活動角色。" : "已授予活動角色。",
              `/events/${encodeURIComponent(selectedEvent.id)}/members/assign`,
              "POST",
              {
                userId: user.id,
                role,
                merchantId: role === "merchant" ? merchantId : null,
              }
            );
          }}
        >
          <h4>授予／更新活動角色</h4>
          <div className="access-form-fields">
            <label htmlFor={`${formId}-event`}>
              可授權活動
              <select
                id={`${formId}-event`}
                required
                value={selectedEvent ? eventId : ""}
                disabled={disabled}
                onChange={event => chooseEvent(event.target.value)}
              >
                <option value="">請選擇活動</option>
                {events.map(event => (
                  <option key={event.id} value={event.id}>
                    {event.name}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${formId}-role`}>
              角色
              <select
                id={`${formId}-role`}
                value={role}
                disabled={disabled || !selectedEvent || ownerAssignment}
                onChange={event => {
                  setRole(event.target.value as Role);
                  setMerchantId("");
                  setValidationError("");
                }}
              >
                {assignableRoles.map(item => (
                  <option
                    key={item}
                    value={item}
                    disabled={
                      selectedEvent?.mode === "attendance" &&
                      (item === "draw" || item === "merchant")
                    }
                  >
                    {roleNames[item]}
                  </option>
                ))}
              </select>
            </label>
            {role === "merchant" && (
              <label htmlFor={`${formId}-merchant`}>
                商戶
                <select
                  id={`${formId}-merchant`}
                  required
                  value={merchantId}
                  disabled={disabled || !selectedEvent}
                  onChange={event => setMerchantId(event.target.value)}
                >
                  <option value="">請選擇商戶</option>
                  {selectedEvent?.merchants.map(merchant => (
                    <option key={merchant.id} value={merchant.id}>
                      {merchant.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {ownerAssignment ? (
            <p className="access-note">
              此帳戶是活動擁有者，不可在此改為其他角色。
            </p>
          ) : selectedEvent?.mode === "attendance" ? (
            <p className="access-muted">簽到典禮模式不提供商戶或抽獎角色。</p>
          ) : role === "merchant" && selectedEvent?.merchants.length === 0 ? (
            <p className="access-note">
              此活動尚未有可授權商戶；請先建立商戶。
            </p>
          ) : null}
          <div className="access-actions">
            <button
              type="submit"
              className="button button-dark"
              disabled={disabled || !canAssign}
            >
              {busy === assignAction
                ? "儲存中…"
                : existing
                  ? "更新角色"
                  : "授予角色"}
            </button>
            <small>
              每個帳戶在同一活動的啟用角色會被更新，不會另外新增重複角色。
            </small>
          </div>
          {validationError && (
            <p role="alert" className="access-error">
              {validationError}
            </p>
          )}
        </form>
      )}
    </article>
  );
}

export default AccessManagement;
