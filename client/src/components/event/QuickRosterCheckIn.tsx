import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { CircleAlert, LockKeyhole, Search as SearchIcon } from "lucide-react";
import { api, idempotencyKey } from "@/lib/eventflow-api";
import { formatEventDate, formatEventVenue } from "@/lib/event-date";
import { useParticipantAccessPending } from "@/components/event/ParticipantSessionGuard";
import {
  getParticipantStatus,
  getRememberedParticipant,
  hasParticipantDeviceMarker,
  isSafeParticipantInviteToken,
  participantNow,
  rememberParticipantInvite,
} from "@/lib/participant-session";
import type { EventInfo, Guest, Invitation } from "@shared/eventflow";
import type { TemporaryParticipant } from "@shared/participant";
import { registrationPhone } from "@shared/registration";
import type { RosterMatchView } from "@shared/roster";
import {
  DESK_ERROR,
  nameDirectoryView,
  requestError,
  sameParticipant,
  searchView,
} from "@/components/event/RosterRegistration";
import "@/styles/event-mobile.css";
import "@/styles/quick-roster.css";

type Props = { event: EventInfo; slug: string };
type Lookup = {
  name: string;
  candidates: RosterMatchView[];
  requiresRefinement: boolean;
  revision: number;
  context: string;
  participant: TemporaryParticipant | null;
};
type RegistrationResult = { guest: Guest; invitation: Invitation };
type RegistrationAttempt = {
  body: Record<string, unknown>;
  key: string;
  context: string;
  participant: TemporaryParticipant | null;
  guestId?: string;
  result?: RegistrationResult;
};
type Phase = "idle" | "searching" | "confirming" | "walkin";
type NameDirectorySort = "name" | "phone";

const MAX_SUGGESTIONS = 8;

/** Loose comparison key for typing: ignores case, spaces and punctuation. */
export function nameKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s.\-_'’·,()（）]/gu, "");
}

/** Rank names-only directory entries for an as-you-type list. */
export function suggestNames(
  names: readonly string[],
  query: string,
  limit = MAX_SUGGESTIONS
): string[] {
  const q = nameKey(query);
  if (!q) return [];
  const scored: { name: string; score: number }[] = [];
  for (const name of names) {
    const key = nameKey(name);
    let score = -1;
    if (key === q) score = 0;
    else if (key.startsWith(q)) score = 1;
    else if (
      name
        .normalize("NFKC")
        .toLocaleLowerCase()
        .split(/[\s.\-_()（）]+/u)
        .some(part => part && nameKey(part).startsWith(q))
    )
      score = 2;
    else if (key.includes(q)) score = 3;
    if (score >= 0) scored.push({ name, score });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.name.localeCompare(b.name, "zh-Hant", { sensitivity: "base" })
    )
    .slice(0, limit)
    .map(item => item.name);
}

function groupLine(match: RosterMatchView): string {
  const label = (match.table?.label ?? "")
    .replace(/\s*·?\s*\d+\s*號枱\s*$/u, "")
    .trim();
  const cls = [match.classType, match.classNumber].filter(Boolean).join("");
  return [...new Set([cls, label || match.chapter].filter(Boolean))].join(
    " · "
  );
}

export default function QuickRosterCheckIn({ event, slug }: Props) {
  const accessPending = useParticipantAccessPending();
  const inputId = useId();
  const open = event.registrationOpen && event.status !== "closed";
  const context = JSON.stringify([
    event.id,
    slug,
    open,
    event.registrationCheckIn,
  ]);
  const [query, setQuery] = useState("");
  const [names, setNames] = useState<string[] | null>(null);
  const [nameSort, setNameSort] = useState<NameDirectorySort>("name");
  const [namesFailed, setNamesFailed] = useState(false);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [selected, setSelected] = useState<RosterMatchView | null>(null);
  const [phone, setPhone] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [walkName, setWalkName] = useState("");
  const [walkPhone, setWalkPhone] = useState("");
  const [walkInviter, setWalkInviter] = useState("");
  const [walkError, setWalkError] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState(false);
  const registrationAttempt = useRef<RegistrationAttempt | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const busy = useRef(false);
  const pendingRef = useRef(accessPending);
  const contextRef = useRef(context);
  const requestRef = useRef<{ signature: string; key: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLElement>(null);
  const helpRef = useRef<HTMLElement>(null);
  const walkRequestRef = useRef<{ signature: string; key: string } | null>(
    null
  );
  pendingRef.current = accessPending;
  contextRef.current = context;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current += 1;
      registrationAttempt.current = null;
    };
  }, []);

  useEffect(() => {
    // A revalidation or event-setting change cannot leave confirmable old results.
    revision.current += 1;
    requestRef.current = null;
    setLookup(null);
    setSelected(null);
    setError(null);
    setNewName(null);
    if (registrationAttempt.current?.context !== context) {
      registrationAttempt.current = null;
      setRecoverable(false);
    }
  }, [context, accessPending]);

  useEffect(() => {
    const attempt = registrationAttempt.current;
    if (!accessPending && attempt?.result && attempt.context === context) {
      void finishAttempt(attempt).catch(() => {
        if (mounted.current) setError(DESK_ERROR);
      });
    }
  }, [context, accessPending]);

  useEffect(() => {
    if (!open || !slug || accessPending) return;
    let cancelled = false;
    setNamesFailed(false);
    setNames(null);
    api<unknown>(
      `/public/events/${encodeURIComponent(slug)}/quick-names`,
      "POST",
      { sort: nameSort }
    )
      .then(result => {
        if (!cancelled && mounted.current)
          setNames(nameDirectoryView(result).names);
      })
      .catch(() => {
        if (!cancelled && mounted.current) {
          setNames([]);
          setNamesFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [context, accessPending, nameSort]);

  function current(version: number, scope: string) {
    return (
      mounted.current &&
      !pendingRef.current &&
      revision.current === version &&
      contextRef.current === scope
    );
  }

  function expired() {
    revision.current += 1;
    setLookup(null);
    setSelected(null);
    requestRef.current = null;
    registrationAttempt.current = null;
    setRecoverable(false);
    window.location.assign("/participant?expired=1");
  }

  async function verifiedAccess(
    version: number,
    scope: string
  ): Promise<TemporaryParticipant | null | undefined> {
    const status = await getParticipantStatus();
    if (!current(version, scope)) return undefined;
    const remembered = getRememberedParticipant();
    if (
      status.expired ||
      (!status.session && (remembered || hasParticipantDeviceMarker())) ||
      (status.session &&
        remembered &&
        (status.session.id !== remembered.id ||
          status.session.issuedAt !== remembered.issuedAt ||
          status.session.expiresAt !== remembered.expiresAt)) ||
      (status.session &&
        Date.parse(status.session.expiresAt) <= participantNow())
    ) {
      expired();
      return undefined;
    }
    return status.session;
  }

  async function finishAttempt(attempt: RegistrationAttempt) {
    if (
      !mounted.current ||
      pendingRef.current ||
      registrationAttempt.current !== attempt ||
      contextRef.current !== attempt.context ||
      !attempt.result
    )
      return;
    const after = await verifiedAccess(revision.current, attempt.context);
    if (
      after === undefined ||
      registrationAttempt.current !== attempt ||
      !mounted.current ||
      pendingRef.current ||
      contextRef.current !== attempt.context
    )
      return;
    if (!sameParticipant(attempt.participant, after)) {
      expired();
      return;
    }
    const result = attempt.result;
    if (
      !result.guest?.id ||
      (attempt.guestId && result.guest.id !== attempt.guestId) ||
      !isSafeParticipantInviteToken(result.invitation?.token)
    )
      throw new Error(DESK_ERROR);
    registrationAttempt.current = null;
    setRecoverable(false);
    if (after) rememberParticipantInvite(result.invitation.token, after);
    window.location.assign(
      `/guest#invite=${encodeURIComponent(result.invitation.token)}`
    );
  }

  async function sendAttempt(
    body: Record<string, unknown>,
    key: string,
    scope: string,
    participant: TemporaryParticipant | null,
    guestId?: string
  ) {
    const attempt: RegistrationAttempt = {
      body,
      key,
      context: scope,
      participant,
      guestId,
    };
    registrationAttempt.current = attempt;
    const result = await api<RegistrationResult>(
      `/public/events/${encodeURIComponent(slug)}/register`,
      "POST",
      body,
      key
    );
    if (
      !mounted.current ||
      registrationAttempt.current !== attempt ||
      contextRef.current !== scope
    )
      return;
    // A foreground revalidation may invalidate the lookup, not this completed
    // transaction. Keep its result until the same participant is verified again.
    attempt.result = result;
    await finishAttempt(attempt);
  }

  async function resumeAttempt() {
    const attempt = registrationAttempt.current;
    if (
      !attempt ||
      busy.current ||
      pendingRef.current ||
      attempt.context !== contextRef.current
    )
      return;
    busy.current = true;
    setPhase("confirming");
    setError(null);
    try {
      const participant = await verifiedAccess(
        revision.current,
        attempt.context
      );
      if (participant === undefined || registrationAttempt.current !== attempt)
        return;
      if (!sameParticipant(attempt.participant, participant)) {
        expired();
        return;
      }
      if (!attempt.result) {
        const result = await api<RegistrationResult>(
          `/public/events/${encodeURIComponent(slug)}/register`,
          "POST",
          attempt.body,
          attempt.key
        );
        if (
          !mounted.current ||
          registrationAttempt.current !== attempt ||
          contextRef.current !== attempt.context
        )
          return;
        attempt.result = result;
      }
      await finishAttempt(attempt);
    } catch (cause) {
      if (mounted.current && registrationAttempt.current === attempt)
        setError(requestError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPhase("idle");
        setRecoverable(Boolean(registrationAttempt.current));
      }
    }
  }

  function typeName(value: string) {
    setQuery(value);
    setError(null);
    setNewName(null);
    registrationAttempt.current = null;
    setRecoverable(false);
    revision.current += 1;
    requestRef.current = null;
    setLookup(null);
    setSelected(null);
  }

  function reset() {
    typeName("");
    setPhone("");
    nameRef.current?.focus();
  }

  function openHelp() {
    setNewName(null);
    setHelpOpen(true);
    setWalkError(null);
    if (!walkName.trim() && query.trim()) setWalkName(query.trim());
  }

  function startNewName() {
    if (busy.current || pendingRef.current || !query.trim()) return;
    const name = query.normalize("NFKC").trim().replace(/\s+/gu, " ");
    revision.current += 1;
    setLookup(null);
    setSelected(null);
    setNewName(name);
    setWalkName(name);
    setWalkPhone("");
    setWalkError(null);
    setHelpOpen(false);
    registrationAttempt.current = null;
    setRecoverable(false);
  }

  function pickFromAll(name: string) {
    setShowAll(false);
    setHelpOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
    void find(name);
  }

  async function registerWalkIn(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!open || !slug || busy.current || pendingRef.current) return;
    const name = walkName.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!name) {
      setWalkError("請輸入你的名字。");
      return;
    }
    let normalizedPhone: string;
    try {
      normalizedPhone = registrationPhone(walkPhone);
    } catch (cause) {
      setWalkError(cause instanceof Error ? cause.message : "請檢查電話號碼。");
      return;
    }
    const body = {
      name,
      phone: normalizedPhone,
      invitedBy: walkInviter.trim(),
      consent: true as const,
      walkIn: true as const,
      quickRegistration: true as const,
    };
    const signature = JSON.stringify([event.id, slug, body]);
    if (walkRequestRef.current?.signature !== signature)
      walkRequestRef.current = { signature, key: idempotencyKey() };
    const key = walkRequestRef.current.key;
    const version = revision.current;
    const scope = contextRef.current;
    busy.current = true;
    setPhase("walkin");
    setWalkError(null);
    try {
      const participant = await verifiedAccess(version, scope);
      if (participant === undefined || !current(version, scope)) return;
      await sendAttempt(body, key, scope, participant);
    } catch (cause) {
      if (current(version, scope)) setWalkError(requestError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPhase("idle");
        setRecoverable(Boolean(registrationAttempt.current));
      }
    }
  }

  async function find(rawName: string) {
    const target = rawName.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!open || !slug || busy.current || pendingRef.current || !target) return;
    const version = ++revision.current;
    const scope = contextRef.current;
    busy.current = true;
    requestRef.current = null;
    setQuery(target);
    setLookup(null);
    setSelected(null);
    setPhase("searching");
    setError(null);
    nameRef.current?.blur();
    try {
      const participant = await verifiedAccess(version, scope);
      if (participant === undefined || !current(version, scope)) return;
      const result = await api<unknown>(
        `/public/events/${encodeURIComponent(slug)}/quick-search`,
        "POST",
        { name: target }
      );
      if (!current(version, scope)) return;
      const view = searchView(result);
      const after = await verifiedAccess(version, scope);
      if (after === undefined || !current(version, scope)) return;
      if (!sameParticipant(participant, after)) {
        expired();
        return;
      }
      setLookup({
        name: target,
        ...view,
        revision: version,
        context: scope,
        participant: after,
      });
      setSelected(view.candidates.length === 1 ? view.candidates[0] : null);
    } catch (cause) {
      if (current(version, scope)) setError(requestError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setPhase("idle");
    }
  }

  async function confirm(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const snapshot = lookup;
    const match = selected;
    if (
      !open ||
      !slug ||
      busy.current ||
      pendingRef.current ||
      !snapshot ||
      !match ||
      !snapshot.candidates.includes(match) ||
      !current(snapshot.revision, snapshot.context)
    )
      return;
    let normalizedPhone: string;
    try {
      normalizedPhone = registrationPhone(phone);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "請檢查電話號碼。");
      return;
    }
    // Clicking confirm after the visible privacy note is the affirmative consent.
    const body = {
      name: snapshot.name,
      consent: true as const,
      phone: normalizedPhone,
      confirmedGuestId: match.guestId,
      confirmRoster: true,
      rosterSelection: true,
      quickRegistration: true as const,
    };
    const signature = JSON.stringify([event.id, slug, body]);
    if (requestRef.current?.signature !== signature)
      requestRef.current = { signature, key: idempotencyKey() };
    const key = requestRef.current.key;
    const version = snapshot.revision;
    const scope = snapshot.context;
    busy.current = true;
    setPhase("confirming");
    setError(null);
    try {
      const participant = await verifiedAccess(version, scope);
      if (participant === undefined || !current(version, scope)) return;
      if (!sameParticipant(snapshot.participant, participant)) {
        expired();
        return;
      }
      await sendAttempt(body, key, scope, participant, match.guestId);
    } catch (cause) {
      if (current(version, scope)) setError(requestError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPhase("idle");
        setRecoverable(Boolean(registrationAttempt.current));
      }
    }
  }

  const visibleLookup =
    lookup &&
    !accessPending &&
    lookup.context === context &&
    lookup.revision === revision.current
      ? lookup
      : null;
  const choice =
    visibleLookup && selected && visibleLookup.candidates.includes(selected)
      ? selected
      : null;
  const showSuggestions =
    !choice &&
    !newName &&
    (!visibleLookup || visibleLookup.candidates.length === 0);
  const suggestions = useMemo(
    () => (names && showSuggestions ? suggestNames(names, query) : []),
    [names, query, showSuggestions]
  );
  const disabled = accessPending || phase !== "idle";
  const confirmLabel = event.registrationCheckIn
    ? "是我，確認簽到"
    : "是我，確認登記";
  const id = (suffix: string) => `${inputId}-${suffix}`;
  const allNames = useMemo(
    () =>
      (names ?? []).slice(),
    [names]
  );
  const notFound =
    (visibleLookup && visibleLookup.candidates.length === 0) ||
    (showSuggestions &&
      query.trim() &&
      names &&
      suggestions.length === 0 &&
      !visibleLookup);

  function submitName(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const exact = names?.find(name => nameKey(name) === nameKey(query));
    const pick = exact ?? (suggestions.length === 1 ? suggestions[0] : null);
    void find(pick ?? query);
  }

  return (
    <main
      className="event-mobile event-mobile--registration quick-roster"
      style={
        { "--event-accent": event.brand.color || "#c89538" } as CSSProperties
      }
    >
      <header className="quick-roster__header">
        {event.brand.logoUrl && (
          <img src={event.brand.logoUrl} alt={`${event.brand.name} 標誌`} />
        )}
        <div>
          <h1>{event.name}</h1>
          <p>
            {formatEventDate(event.date)} · {formatEventVenue(event.venue)}
          </p>
        </div>
      </header>

      {!open ? (
        <section className="event-mobile-card event-mobile-status">
          <LockKeyhole size={25} aria-hidden="true" />
          <h2>登記尚未開放</h2>
          <p>請到簽到台由工作人員協助。</p>
        </section>
      ) : (
        <section
          className="event-mobile-card quick-roster__card"
          aria-busy={phase !== "idle"}
        >
          <form
            name="quick-roster-name"
            onSubmit={submitName}
            className="quick-roster__search"
          >
            <label htmlFor={id("name")}>輸入你的名字</label>
            <div className="quick-roster__field">
              <SearchIcon size={20} aria-hidden="true" />
              <input
                ref={nameRef}
                id={id("name")}
                name="name"
                type="search"
                value={query}
                onChange={e => typeName(e.target.value)}
                autoComplete="off"
                autoCapitalize="words"
                enterKeyHint="search"
                placeholder="中文名或英文名都可以"
                maxLength={120}
                disabled={
                  accessPending || phase === "confirming" || phase === "walkin"
                }
                aria-describedby={id("hint")}
              />
            </div>
            <p id={id("hint")} className="quick-roster__hint">
              打幾個字，然後在下面點選你的名字。
            </p>
            <button
              type="submit"
              className="quick-roster__help-secondary"
              disabled={disabled || !query.trim()}
            >
              查找名字
            </button>
          </form>

          {accessPending && (
            <p className="quick-roster__status" role="status">
              正在確認登入狀態…
            </p>
          )}
          {phase === "searching" && (
            <p className="quick-roster__status" role="status">
              正在查找座位…
            </p>
          )}
          {recoverable && (
            <div className="quick-roster__notice" role="status">
              <p>保留了剛才的登記，可安全接續，不會重複新增。</p>
              <button
                type="button"
                className="event-mobile-primary"
                onClick={() => void resumeAttempt()}
                disabled={disabled}
              >
                繼續剛才的登記
              </button>
            </div>
          )}
          {error && (
            <p
              className="event-mobile-alert event-mobile-alert--error"
              role="alert"
            >
              <CircleAlert size={17} aria-hidden="true" />
              {error}
            </p>
          )}

          {visibleLookup && visibleLookup.candidates.length === 0 && (
            <p className="quick-roster__notice" role="status">
              {visibleLookup.requiresRefinement
                ? "同名人數較多，請到簽到台由工作人員協助。"
                : `「${visibleLookup.name}」未有可自助認領的紀錄，可能已登記或需要人工核對。請使用原嘉賓連結或到簽到台。`}
            </p>
          )}

          {showSuggestions && query.trim() && (
            <ul className="quick-roster__suggestions" aria-label="符合的名字">
              {suggestions.map(name => (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => void find(name)}
                    disabled={disabled}
                  >
                    <span>{name}</span>
                    <span aria-hidden="true">選擇</span>
                  </button>
                </li>
              ))}
              {names && suggestions.length === 0 && !visibleLookup && (
                <li className="quick-roster__empty">
                  {namesFailed
                    ? "名單暫時未能載入，可按鍵盤上的「搜尋」直接查找。"
                    : "找不到這個名字，試輸入英文名、姓氏或少打幾個字；或按下面「找不到我的名字？」。"}
                </li>
              )}
              {!names && <li className="quick-roster__empty">正在載入名單…</li>}
            </ul>
          )}

          {notFound && !helpOpen && (
            <button
              type="button"
              className="quick-roster__help-cta"
              onClick={openHelp}
              disabled={disabled}
            >
              找不到我的名字？按此
            </button>
          )}

          {!newName &&
            !choice &&
            names &&
            !namesFailed &&
            query.trim() &&
            !names.some(name => nameKey(name) === nameKey(query)) &&
            suggestions.length === 0 && (
              <button
                type="button"
                className="event-mobile-primary"
                onClick={startNewName}
                disabled={disabled}
              >
                登記新嘉賓「{query.trim()}」
              </button>
            )}

          {newName && (
            <section
              className="quick-roster__confirm"
              aria-label="確認新嘉賓登記"
            >
              <p className="quick-roster__who">
                <strong>{newName}</strong>
              </p>
              <form name="quick-new-guest" onSubmit={registerWalkIn}>
                <label htmlFor={id("new-phone")}>你的電話</label>
                <input
                  id={id("new-phone")}
                  name="phone"
                  type="tel"
                  value={walkPhone}
                  onChange={e => {
                    setWalkPhone(e.target.value);
                    setWalkError(null);
                  }}
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={32}
                  placeholder="8位香港電話；海外電話請加區號"
                  disabled={disabled}
                />
                {walkError && (
                  <p
                    className="event-mobile-alert event-mobile-alert--error"
                    role="alert"
                  >
                    {walkError}
                  </p>
                )}
                <button
                  type="submit"
                  className="event-mobile-primary"
                  disabled={disabled || !walkPhone.trim()}
                >
                  {phase === "walkin"
                    ? "正在登記…"
                    : event.registrationCheckIn
                      ? "確認登記並簽到"
                      : "確認嘉賓登記"}
                </button>
              </form>
              <details className="quick-roster__privacy">
                <summary>按確認即表示同意私隱說明</summary>
                <p>
                  {event.brand.privacyText ||
                    "主辦方只會按活動所需處理你提供的資料。"}
                </p>
              </details>
              <p className="quick-roster__hint">
                尚未安排座位，請由工作人員協助。
              </p>
              <button
                type="button"
                className="quick-roster__reset"
                onClick={reset}
                disabled={disabled}
              >
                重新輸入名字
              </button>
            </section>
          )}

          {visibleLookup && visibleLookup.candidates.length > 1 && !choice && (
            <div className="quick-roster__choices">
              <p className="quick-roster__hint">
                有同名嘉賓，請按你的班別／分會選擇：
              </p>
              {visibleLookup.candidates.map(match => (
                <button
                  key={match.guestId}
                  type="button"
                  className="quick-roster__choice"
                  onClick={() => setSelected(match)}
                  disabled={disabled}
                >
                  <strong>{match.name}</strong>
                  <span>{groupLine(match) || "原名單未記錄班別"}</span>
                  <em>
                    {match.table ? `${match.table.number} 號枱` : "待安排"}
                    {match.table?.seat != null
                      ? ` · ${match.table.seat} 號位`
                      : ""}
                  </em>
                </button>
              ))}
            </div>
          )}

          {visibleLookup && choice && (
            <section
              ref={confirmRef}
              className="quick-roster__confirm"
              aria-label="確認座位"
            >
              <p className="quick-roster__who">
                <strong>{choice.name}</strong>
                {groupLine(choice) && <span>{groupLine(choice)}</span>}
              </p>
              <div className="quick-roster__seat">
                <div>
                  <span>枱號</span>
                  <strong>
                    {choice.table ? choice.table.number : "待安排"}
                  </strong>
                </div>
                <div>
                  <span>座位</span>
                  <strong>{choice.table?.seat ?? "—"}</strong>
                </div>
              </div>
              <form name="quick-roster-confirm" onSubmit={confirm}>
                <label htmlFor={id("phone")}>你的電話</label>
                <input
                  id={id("phone")}
                  name="phone"
                  type="tel"
                  value={phone}
                  onChange={e => {
                    setPhone(e.target.value);
                    setError(null);
                  }}
                  autoComplete="tel"
                  inputMode="tel"
                  enterKeyHint="done"
                  maxLength={32}
                  placeholder="8位香港電話"
                  disabled={disabled}
                />
                <button
                  type="submit"
                  className="event-mobile-primary"
                  disabled={disabled || !phone.trim()}
                >
                  {phase === "confirming" ? "正在確認…" : confirmLabel}
                </button>
              </form>
              <details className="quick-roster__privacy">
                <summary>按確認即表示同意私隱說明</summary>
                <p>
                  {event.brand.privacyText ||
                    "主辦方只會按活動所需處理你提供的資料。"}
                </p>
              </details>
              <button
                type="button"
                className="quick-roster__reset"
                onClick={reset}
                disabled={disabled}
              >
                不是我，重新輸入
              </button>
            </section>
          )}
        </section>
      )}

      {open && helpOpen && (
        <section
          ref={helpRef}
          className="event-mobile-card quick-roster__help"
          aria-label="找不到名字的應對方法"
        >
          <h2>找不到自己的名字？</h2>
          <ol>
            <li>
              <strong>換個寫法再試</strong>
              <p>
                只打英文名或姓氏（例如「Sample Guest Eta」或「Chan」），也可試中文名或暱稱。名單上有些名字帶「教」、「Dr.」或「嘉賓」字樣，少打幾個字更易找到。
              </p>
              <button
                type="button"
                className="quick-roster__help-secondary"
                onClick={() => {
                  setHelpOpen(false);
                  reset();
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                重新輸入名字
              </button>
            </li>
            <li>
              <strong>看全部名單</strong>
              <p>
                可按姓名或活動嘉賓電話排序；只顯示名字，電話不會公開。點選即可查座位。
              </p>
              <div className="quick-roster__help-secondary" role="group" aria-label="名單排序">
                <button
                  type="button"
                  className={nameSort === "name" ? "event-mobile-primary" : "quick-roster__help-secondary"}
                  onClick={() => setNameSort("name")}
                  disabled={disabled || nameSort === "name"}
                >
                  姓名排序
                </button>
                <button
                  type="button"
                  className={nameSort === "phone" ? "event-mobile-primary" : "quick-roster__help-secondary"}
                  onClick={() => setNameSort("phone")}
                  disabled={disabled || nameSort === "phone"}
                >
                  電話排序（電話不公開）
                </button>
              </div>
              <button
                type="button"
                className="quick-roster__help-secondary"
                onClick={() => setShowAll(value => !value)}
                aria-expanded={showAll}
                disabled={!names || names.length === 0}
              >
                {showAll
                  ? "收起全部名單"
                  : `顯示全部 ${allNames.length} 個名字`}
              </button>
              {showAll && (
                <ul className="quick-roster__all" aria-label="全部嘉賓名字">
                  {allNames.map(name => (
                    <li key={name}>
                      <button
                        type="button"
                        onClick={() => pickFromAll(name)}
                        disabled={disabled}
                      >
                        {name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
            <li>
              <strong>新嘉賓登記</strong>
              <p>
                仍然找不到？可登記姓名及電話，座位由工作人員安排。已在名單上的嘉賓請勿重複登記。
              </p>
              <form
                name="quick-roster-walkin"
                onSubmit={registerWalkIn}
                className="quick-roster__walkin"
              >
                <label htmlFor={id("walk-name")}>你的名字</label>
                <input
                  id={id("walk-name")}
                  name="walkName"
                  value={walkName}
                  onChange={e => {
                    setWalkName(e.target.value);
                    setWalkError(null);
                  }}
                  autoComplete="name"
                  maxLength={120}
                  disabled={disabled}
                />
                <label htmlFor={id("walk-phone")}>你的電話</label>
                <input
                  id={id("walk-phone")}
                  name="walkPhone"
                  type="tel"
                  value={walkPhone}
                  onChange={e => {
                    setWalkPhone(e.target.value);
                    setWalkError(null);
                  }}
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={32}
                  placeholder="8位香港電話"
                  disabled={disabled}
                />
                <label htmlFor={id("walk-inviter")}>
                  邀請人（不知道可留空）
                </label>
                <input
                  id={id("walk-inviter")}
                  name="walkInviter"
                  value={walkInviter}
                  onChange={e => setWalkInviter(e.target.value)}
                  maxLength={120}
                  disabled={disabled}
                />
                {walkError && (
                  <p
                    className="event-mobile-alert event-mobile-alert--error"
                    role="alert"
                  >
                    <CircleAlert size={17} aria-hidden="true" />
                    {walkError}
                  </p>
                )}
                <button
                  type="submit"
                  className="event-mobile-primary"
                  disabled={disabled || !walkName.trim() || !walkPhone.trim()}
                >
                  {phase === "walkin"
                    ? "正在登記…"
                    : event.registrationCheckIn
                      ? "登記並簽到"
                      : "確認嘉賓登記"}
                </button>
                <details className="quick-roster__privacy">
                  <summary>按登記即表示同意私隱說明</summary>
                  <p>
                    {event.brand.privacyText ||
                      "主辦方只會按活動所需處理你提供的資料。"}
                  </p>
                </details>
              </form>
            </li>
            <li>
              <strong>到簽到台</strong>
              <p>
                請向本活動的簽到台工作人員查詢；已有消費或抽獎紀錄者，請使用原來的本人嘉賓連結。
              </p>
            </li>
          </ol>
          <button
            type="button"
            className="quick-roster__reset"
            onClick={() => setHelpOpen(false)}
          >
            收起
          </button>
        </section>
      )}

      <p className="quick-roster__footer">
        已在這部手機登記？<a href="/guest">查看我的嘉賓頁／座位</a>
        <br />
        <button
          type="button"
          className="quick-roster__link"
          onClick={openHelp}
          disabled={!open}
        >
          找不到我的名字？
        </button>
      </p>
    </main>
  );
}
