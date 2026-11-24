import { useCallback, useEffect, useId, useRef, useState } from "react";
import { KeyRound, UserPlus } from "lucide-react";
import type { AccessDirectory, Guest, Role } from "@shared/eventflow";
import { memberCodeOf } from "@shared/eventflow";
import {
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
  normalizeUsername,
  type LocalAccount,
  type LocalAccountKind,
} from "@shared/local-login";
import { api, idempotencyKey } from "@/lib/eventflow-api";

const roleNames: Record<Role, string> = {
  owner: "活動擁有者",
  admin: "活動管理員",
  project_manager: "項目管理員",
  guest_manager: "嘉賓管理員",
  checkin: "簽到工作人員",
  draw: "抽獎工作人員",
  merchant: "商戶工作人員",
};
const staffRoles: Role[] = [
  "merchant",
  "checkin",
  "guest_manager",
  "draw",
  "project_manager",
  "admin",
];

type GuestOption = Pick<Guest, "id" | "name" | "ticket" | "memberCode">;

function messageFrom(reason: unknown) {
  return reason instanceof Error ? reason.message : "操作未能完成，請重試。";
}

/**
 * Create and maintain username/password accounts (merchants, staff, members)
 * so the organiser can rehearse with phones that have no Google account.
 */
export default function LocalAccountsPanel({
  events,
  disabled: parentDisabled = false,
  onChanged,
}: {
  events: AccessDirectory["events"];
  disabled?: boolean;
  onChanged?: () => void;
}) {
  const formId = useId();
  const [accounts, setAccounts] = useState<LocalAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kind, setKind] = useState<LocalAccountKind>("staff");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [role, setRole] = useState<Role>("merchant");
  const [merchantId, setMerchantId] = useState("");
  const [guestId, setGuestId] = useState("");
  const [guestQuery, setGuestQuery] = useState("");
  const [guests, setGuests] = useState<GuestOption[]>([]);
  const [guestsLoading, setGuestsLoading] = useState(false);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const lock = useRef(false);
  const createKey = useRef(idempotencyKey());
  const createSignature = useRef("");

  const selectedEvent = events.find(event => event.id === eventId) ?? null;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<{ accounts: LocalAccount[] }>(
        "/system/local-accounts"
      );
      setAccounts(next.accounts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload().catch(reason => setError(messageFrom(reason)));
  }, [reload]);

  useEffect(() => {
    if (!eventId && events[0]) setEventId(events[0].id);
  }, [events, eventId]);

  // Member accounts need the event roster so the organiser can pick a guest.
  useEffect(() => {
    if (kind !== "member" || !eventId) {
      setGuests([]);
      return;
    }
    let active = true;
    setGuestsLoading(true);
    void api<{ guests: GuestOption[] }>(`/events/${eventId}/state`)
      .then(state => {
        if (active) setGuests(state.guests ?? []);
      })
      .catch(reason => {
        if (active) setError(messageFrom(reason));
      })
      .finally(() => {
        if (active) setGuestsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [kind, eventId]);

  const usernameValid = USERNAME_PATTERN.test(normalizeUsername(username));
  const passwordValid = password.length >= PASSWORD_MIN_LENGTH;
  const canCreate =
    usernameValid &&
    passwordValid &&
    (kind === "staff"
      ? !role || (eventId && (role !== "merchant" || merchantId))
      : Boolean(eventId && guestId));

  const create = async () => {
    if (lock.current || !canCreate) return;
    lock.current = true;
    setBusy("create");
    setError("");
    setNotice("");
    const body = {
      username: normalizeUsername(username),
      password,
      displayName: displayName.trim() || undefined,
      kind,
      eventId: eventId || undefined,
      ...(kind === "staff" && role
        ? { role, merchantId: role === "merchant" ? merchantId : undefined }
        : {}),
      ...(kind === "member" ? { guestId } : {}),
    };
    const signature = JSON.stringify(body);
    if (createSignature.current !== signature)
      createKey.current = idempotencyKey();
    createSignature.current = signature;
    try {
      const result = await api<{
        account: LocalAccount | null;
        accounts: LocalAccount[];
      }>("/system/local-accounts", "POST", body, createKey.current);
      setAccounts(result.accounts);
      setNotice(
        `已建立帳號「${body.username}」。請把帳號與密碼交給使用者；密碼不會再顯示。`
      );
      setUsername("");
      setPassword("");
      setDisplayName("");
      setGuestId("");
      setGuestQuery("");
      createSignature.current = "";
      createKey.current = idempotencyKey();
      onChanged?.();
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const patch = async (
    account: LocalAccount,
    body: { password?: string; active?: boolean },
    message: string
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(account.id);
    setError("");
    setNotice("");
    try {
      const result = await api<{ accounts: LocalAccount[] }>(
        `/system/local-accounts/${encodeURIComponent(account.id)}`,
        "PATCH",
        body
      );
      setAccounts(result.accounts);
      setNotice(message);
      setResetTarget(null);
      setResetPassword("");
      onChanged?.();
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const disabled = parentDisabled || busy !== null;
  const filteredGuests = guests
    .filter(guest => {
      const q = guestQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        guest.name.toLowerCase().includes(q) ||
        guest.ticket.includes(q) ||
        memberCodeOf(guest).toLowerCase().includes(q)
      );
    })
    .slice(0, 50);

  return (
    <section
      className="access-panel local-accounts"
      aria-labelledby="local-accounts-title"
      aria-busy={loading}
    >
      <div className="access-directory-heading">
        <div>
          <h2 id="local-accounts-title">
            <KeyRound size={18} aria-hidden="true" /> 帳號密碼登入帳戶
          </h2>
          <p>
            為商家、工作人員或會員建立不需 Google
            的登入帳號。帳號在登入頁的「帳號密碼登入」使用；商家／工作人員登入後直達工作台，會員登入後直達自己的嘉賓頁。
          </p>
        </div>
        {accounts && (
          <span className="access-badge">{accounts.length} 個帳號</span>
        )}
      </div>

      <div className="access-feedback" aria-live="polite">
        {error && (
          <p role="alert" className="access-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="access-success">
            {notice}
          </p>
        )}
      </div>

      <form
        className="access-assignment-form"
        onSubmit={event => {
          event.preventDefault();
          void create();
        }}
      >
        <h4>
          <UserPlus size={16} aria-hidden="true" /> 建立新帳號
        </h4>
        <div className="access-form-fields">
          <label htmlFor={`${formId}-kind`}>
            帳號類型
            <select
              id={`${formId}-kind`}
              value={kind}
              disabled={disabled}
              onChange={event => {
                setKind(event.target.value as LocalAccountKind);
                setGuestId("");
              }}
            >
              <option value="staff">商家／工作人員</option>
              <option value="member">會員（嘉賓）</option>
            </select>
          </label>
          <label htmlFor={`${formId}-username`}>
            帳號（小寫英文、數字）
            <input
              id={`${formId}-username`}
              value={username}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="例如 shop1 或 bp54"
              disabled={disabled}
              onChange={event => setUsername(event.target.value)}
            />
          </label>
          <label htmlFor={`${formId}-password`}>
            密碼（至少 {PASSWORD_MIN_LENGTH} 位）
            <input
              id={`${formId}-password`}
              type="text"
              autoComplete="off"
              value={password}
              placeholder="交給使用者的密碼"
              disabled={disabled}
              onChange={event => setPassword(event.target.value)}
            />
          </label>
          <label htmlFor={`${formId}-display`}>
            顯示名稱（可留空）
            <input
              id={`${formId}-display`}
              value={displayName}
              maxLength={120}
              placeholder="例如 甜品檔 A"
              disabled={disabled}
              onChange={event => setDisplayName(event.target.value)}
            />
          </label>
          <label htmlFor={`${formId}-event`}>
            活動
            <select
              id={`${formId}-event`}
              value={eventId}
              disabled={disabled}
              onChange={event => {
                setEventId(event.target.value);
                setMerchantId("");
                setGuestId("");
              }}
            >
              {kind === "staff" && <option value="">暫不指派活動角色</option>}
              {events.map(event => (
                <option key={event.id} value={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
          </label>
          {kind === "staff" && eventId && (
            <label htmlFor={`${formId}-role`}>
              活動角色
              <select
                id={`${formId}-role`}
                value={role}
                disabled={disabled}
                onChange={event => {
                  setRole(event.target.value as Role);
                  setMerchantId("");
                }}
              >
                {staffRoles.map(item => (
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
          )}
          {kind === "staff" && eventId && role === "merchant" && (
            <label htmlFor={`${formId}-merchant`}>
              商戶
              <select
                id={`${formId}-merchant`}
                value={merchantId}
                disabled={disabled}
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
          {kind === "member" && (
            <>
              <label htmlFor={`${formId}-guest-search`}>
                搜尋嘉賓（姓名／票號／會員碼）
                <input
                  id={`${formId}-guest-search`}
                  type="search"
                  value={guestQuery}
                  disabled={disabled || guestsLoading}
                  placeholder={guestsLoading ? "正在讀取嘉賓…" : "輸入關鍵字"}
                  onChange={event => setGuestQuery(event.target.value)}
                />
              </label>
              <label htmlFor={`${formId}-guest`}>
                綁定嘉賓
                <select
                  id={`${formId}-guest`}
                  value={guestId}
                  disabled={disabled || guestsLoading}
                  onChange={event => setGuestId(event.target.value)}
                >
                  <option value="">請選擇嘉賓</option>
                  {filteredGuests.map(guest => (
                    <option key={guest.id} value={guest.id}>
                      {guest.name}（{memberCodeOf(guest)}）
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        {kind === "member" &&
          eventId &&
          !guestsLoading &&
          guests.length === 0 && (
            <p className="access-note">
              此活動尚未有嘉賓；請先在「嘉賓管理」加入嘉賓，再建立會員帳號。
            </p>
          )}
        {kind === "staff" &&
          role === "merchant" &&
          eventId &&
          selectedEvent?.merchants.length === 0 && (
            <p className="access-note">此活動尚未有商戶；請先建立商戶。</p>
          )}
        <div className="access-actions">
          <button
            type="submit"
            className="button button-dark"
            disabled={disabled || !canCreate}
          >
            {busy === "create" ? "建立中…" : "建立帳號"}
          </button>
          <small>
            帳號名稱不可重複；密碼只會以加密雜湊保存，之後只能重設、不能查看。
          </small>
        </div>
      </form>

      {!accounts && loading ? (
        <div className="access-empty" role="status">
          正在讀取帳號…
        </div>
      ) : accounts && accounts.length === 0 ? (
        <div className="access-empty">
          <h3>尚未建立帳號密碼登入帳戶</h3>
          <p>建立後會在此列出；可隨時重設密碼或停用。</p>
        </div>
      ) : accounts ? (
        <ul className="access-user-list">
          {accounts.map(account => (
            <li key={account.id} className="access-user">
              <div className="access-user-heading">
                <div>
                  <strong>{account.displayName}</strong>
                  <span className="access-muted">
                    {" "}
                    @{account.username} ·{" "}
                    {account.kind === "member" ? "會員" : "商家／工作人員"}
                    {!account.active ? " · 已停用" : ""}
                  </span>
                </div>
                <span
                  className={`access-badge ${
                    account.active ? "" : "access-badge-pending"
                  }`}
                >
                  {account.lastLoginAt
                    ? `上次登入 ${new Date(account.lastLoginAt).toLocaleString("zh-HK")}`
                    : "未曾登入"}
                </span>
              </div>
              <div className="access-assignments">
                {account.kind === "member" ? (
                  <span>
                    {account.eventName ?? "活動"} · 嘉賓{" "}
                    {account.guestName ?? "（已移除）"}
                    {account.memberCode
                      ? ` · 會員碼 ${account.memberCode}`
                      : ""}
                  </span>
                ) : account.assignments.length ? (
                  account.assignments.map(assignment => (
                    <span key={`${assignment.eventId}-${assignment.role}`}>
                      {assignment.eventName} ·{" "}
                      {roleNames[assignment.role as Role] ?? assignment.role}
                      {assignment.merchantName
                        ? ` · ${assignment.merchantName}`
                        : ""}
                    </span>
                  ))
                ) : (
                  <span className="access-muted">
                    尚未指派活動角色；可在上方「已登入帳戶」清單為此帳號授予角色。
                  </span>
                )}
              </div>
              <div className="access-actions">
                {resetTarget === account.id ? (
                  <>
                    <input
                      type="text"
                      autoComplete="off"
                      value={resetPassword}
                      placeholder={`新密碼（至少 ${PASSWORD_MIN_LENGTH} 位）`}
                      disabled={disabled}
                      onChange={event => setResetPassword(event.target.value)}
                    />
                    <button
                      type="button"
                      className="button button-dark"
                      disabled={
                        disabled || resetPassword.length < PASSWORD_MIN_LENGTH
                      }
                      onClick={() =>
                        void patch(
                          account,
                          { password: resetPassword },
                          `已重設「${account.username}」的密碼。`
                        )
                      }
                    >
                      {busy === account.id ? "儲存中…" : "確認重設"}
                    </button>
                    <button
                      type="button"
                      className="button button-white"
                      disabled={disabled}
                      onClick={() => {
                        setResetTarget(null);
                        setResetPassword("");
                      }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="button button-white"
                      disabled={disabled}
                      onClick={() => {
                        setResetTarget(account.id);
                        setResetPassword("");
                      }}
                    >
                      重設密碼
                    </button>
                    <button
                      type="button"
                      className={`button ${
                        account.active ? "access-button-danger" : "button-dark"
                      }`}
                      disabled={disabled}
                      onClick={() =>
                        void patch(
                          account,
                          { active: !account.active },
                          account.active
                            ? `已停用「${account.username}」。`
                            : `已重新啟用「${account.username}」。`
                        )
                      }
                    >
                      {account.active ? "停用" : "啟用"}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
