import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { CheckCircle2, CircleAlert, LockKeyhole, Ticket } from "lucide-react";
import { ApiError, api, idempotencyKey } from "@/lib/eventflow-api";
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
import {
  CLASS_TYPES,
  parseClass,
  registrationPhone,
  type ClassType,
} from "@shared/registration";
import {
  CHAPTERS,
  NO_CHAPTER,
  ROSTER_CANDIDATE_LIMIT,
  type RosterMatchView,
  type RosterNameDirectoryView,
  type RosterSearchInput,
  type RosterSearchView,
} from "@shared/roster";
import "@/styles/event-mobile.css";
import "@/styles/roster-registration.css";

type Props = { event: EventInfo; slug: string };
type Fields = {
  name: string;
  chapter: string;
  invitedBy: string;
  classType: ClassType | "";
  classNumber: string;
  phone: string;
  consent: boolean;
};
type SearchPayload = RosterSearchInput & { consent: true };
type Search = RosterSearchView & {
  payload: SearchPayload;
  revision: number;
  context: string;
  participant: TemporaryParticipant | null;
};
type NameDirectory = RosterNameDirectoryView & {
  revision: number;
  context: string;
};
type RegistrationResult = { guest: Guest; invitation: Invitation };
type Phase = "idle" | "matching" | "confirming";

export const DESK_ERROR =
  "未能核對你的名單紀錄，請補充資料或到簽到台由工作人員協助；不會自動新增嘉賓。";

/** Rebuild only the public allowlist; never retain a private Guest object. */
export function candidateMatch(value: unknown): RosterMatchView {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(DESK_ERROR);
  const match = value as Record<string, unknown>;
  if (
    typeof match.guestId !== "string" ||
    !match.guestId.trim() ||
    typeof match.name !== "string" ||
    !match.name.trim() ||
    typeof match.chapter !== "string" ||
    typeof match.invitedBy !== "string" ||
    typeof match.classType !== "string" ||
    typeof match.classNumber !== "string"
  )
    throw new Error(DESK_ERROR);

  let table: RosterMatchView["table"] = null;
  if (match.table !== null) {
    if (
      !match.table ||
      typeof match.table !== "object" ||
      Array.isArray(match.table)
    )
      throw new Error(DESK_ERROR);
    const seat = match.table as Record<string, unknown>;
    if (
      typeof seat.number !== "number" ||
      !Number.isSafeInteger(seat.number) ||
      seat.number < 1 ||
      typeof seat.label !== "string" ||
      (seat.seat !== null &&
        (typeof seat.seat !== "number" ||
          !Number.isSafeInteger(seat.seat) ||
          seat.seat < 1))
    )
      throw new Error(DESK_ERROR);
    table = {
      number: seat.number,
      label: seat.label,
      seat: seat.seat as number | null,
    };
  }
  return {
    guestId: match.guestId,
    name: match.name,
    chapter: match.chapter,
    invitedBy: match.invitedBy,
    classType: match.classType,
    classNumber: match.classNumber,
    table,
  };
}

/** Reject unbounded/malformed responses rather than truncating a private list. */
export function searchView(value: unknown): RosterSearchView {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(DESK_ERROR);
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.candidates) ||
    raw.candidates.length > ROSTER_CANDIDATE_LIMIT ||
    typeof raw.requiresRefinement !== "boolean"
  )
    throw new Error(DESK_ERROR);
  const candidates = Array.from(raw.candidates, candidateMatch);
  if (
    new Set(candidates.map(match => match.guestId)).size !== candidates.length
  )
    throw new Error(DESK_ERROR);
  // A refinement response is never a selectable, arbitrarily truncated shortlist.
  return {
    candidates: raw.requiresRefinement ? [] : candidates,
    requiresRefinement: raw.requiresRefinement,
  };
}

/** Accept only the approved, bounded names-only directory response. */
export function nameDirectoryView(value: unknown): RosterNameDirectoryView {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(DESK_ERROR);
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 1 ||
    !Array.isArray(raw.names) ||
    raw.names.length > 10_000 ||
    raw.names.some(
      name =>
        typeof name !== "string" ||
        !name.trim() ||
        name.trim().length > 120
    )
  )
    throw new Error(DESK_ERROR);
  return { names: raw.names as string[] };
}

export function requestError(error: unknown) {
  // Do not echo arbitrary server messages: they could include private names or phones.
  if (error instanceof Error && error.message === DESK_ERROR) return DESK_ERROR;
  if (error instanceof ApiError) {
    const hint = `${error.code || ""} ${error.message}`;
    if (/alias|代稱|別名|manual|人工/iu.test(hint)) {
      return "代稱或別名需要人工核對，請到簽到台提供資料；不會自動新增嘉賓。";
    }
    if (
      /ambiguous|duplicate|multiple|claimed|重複|多於|多人|已認領|已登記/iu.test(
        hint
      )
    ) {
      return "資料需進一步核對，或座位已被認領。請補充資料或到簽到台；不會重複新增嘉賓。";
    }
    if (
      /no.?match|not.?found|找不到|未找到|無匹配|沒有符合/iu.test(hint) ||
      error.status === 404
    ) {
      return "找不到符合的名單紀錄。請檢查姓名或補充分會、班別及邀請人；仍未找到請到簽到台，不會自動新增嘉賓。";
    }
    if ([400, 401, 403, 409, 422].includes(error.status)) return DESK_ERROR;
  }
  return "暫時未能完成操作，請保留資料後重試；如仍未能核對，請到簽到台。";
}

export function sameParticipant(
  a: TemporaryParticipant | null,
  b: TemporaryParticipant | null
) {
  return a === null
    ? b === null
    : Boolean(
        b &&
          a.id === b.id &&
          a.issuedAt === b.issuedAt &&
          a.expiresAt === b.expiresAt
      );
}

export default function RosterRegistration({ event, slug }: Props) {
  const accessPending = useParticipantAccessPending();
  const inputId = useId();
  const configuredChapters = event.rosterChapters
    ?.map(chapter => chapter.trim())
    .filter(Boolean);
  const chapters = [
    ...new Set(configuredChapters?.length ? configuredChapters : CHAPTERS),
  ].filter(chapter => chapter !== NO_CHAPTER);
  const open = event.registrationOpen && event.status !== "closed";
  const context = JSON.stringify([
    event.id,
    slug,
    open,
    event.registrationCheckIn,
    chapters,
  ]);
  const [fields, setFields] = useState<Fields>({
    name: "",
    chapter: "",
    invitedBy: "",
    classType: "",
    classNumber: "",
    phone: "",
    consent: false,
  });
  const [search, setSearch] = useState<Search | null>(null);
  const [directory, setDirectory] = useState<NameDirectory | null>(null);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [selection, setSelection] = useState<RosterMatchView | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const busy = useRef(false);
  const fieldsRef = useRef(fields);
  const searchRef = useRef<Search | null>(null);
  const selectionRef = useRef<RosterMatchView | null>(null);
  const pendingRef = useRef(accessPending);
  const contextRef = useRef(context);
  const requestRef = useRef<{
    signature: string;
    key: string;
    guestId: string;
  } | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  pendingRef.current = accessPending;
  contextRef.current = context;

  function clearResults() {
    searchRef.current = null;
    selectionRef.current = null;
    setSearch(null);
    setSelection(null);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current += 1;
      searchRef.current = null;
      selectionRef.current = null;
    };
  }, []);

  useEffect(() => {
    // A revalidation or event-setting change cannot leave confirmable old results.
    revision.current += 1;
    clearResults();
    requestRef.current = null;
    setDirectory(null);
    setDirectoryQuery("");
    setNotice(null);
    setError(null);
  }, [context, accessPending]);

  useEffect(() => {
    if (accessPending) return;
    if (selection) previewHeading.current?.focus();
    else if (search) resultHeading.current?.focus();
  }, [search?.candidates, selection, accessPending]);

  function current(version: number, scope: string) {
    return (
      mounted.current &&
      !pendingRef.current &&
      revision.current === version &&
      contextRef.current === scope
    );
  }

  function change(patch: Partial<Fields>) {
    const previous = searchRef.current;
    fieldsRef.current = { ...fieldsRef.current, ...patch };
    const version = ++revision.current;
    // Preserve the key for a phone-only edit. The final canonical body signature
    // decides whether a new UUID is needed, so formatting cannot change the actor.
    if (!(Object.keys(patch).length === 1 && "phone" in patch))
      requestRef.current = null;
    setFields(fieldsRef.current);
    setError(null);
    if (Object.keys(patch).length === 1 && "phone" in patch) {
      // Phone is not a search filter. Keep the candidate, cancel only an old confirmation.
      if (previous && previous.context === contextRef.current) {
        const next = { ...previous, revision: version };
        searchRef.current = next;
        setSearch(next);
      }
      setNotice(null);
      return;
    }
    clearResults();
    setDirectory(null);
    setDirectoryQuery("");
    setNotice(
      previous || busy.current
        ? "資料已修改，舊查找結果已取消；請重新查找座位。"
        : null
    );
  }

  function payload(): SearchPayload {
    const value = fieldsRef.current;
    if (!value.name.trim())
      throw new Error("請輸入你的姓名，盡量與大會名單一致。");
    if (
      value.chapter &&
      value.chapter !== NO_CHAPTER &&
      !chapters.includes(value.chapter)
    )
      throw new Error("請選擇分會，或選略過／不確定。");
    if (!value.consent) throw new Error("請先閱讀並同意資料使用說明。");
    if (value.classType && !CLASS_TYPES.includes(value.classType))
      throw new Error("請選擇班種：BP、格局、金魂或CBL。");
    const number = value.classNumber.normalize("NFKC").trim();
    let classes: Pick<RosterSearchInput, "classType" | "classNumber"> = {};
    if (value.classType && number) {
      classes = parseClass(value.classType, number, false);
    } else if (value.classType) {
      classes = { classType: value.classType };
    } else if (number) {
      if (!/^\d{1,4}$/.test(number) || Number(number) < 1)
        throw new Error("請輸入1至9999的班號，例如 62；班種可留空。");
      classes = { classNumber: String(Number(number)) };
    }
    return {
      name: value.name.trim(),
      ...(value.chapter ? { chapter: value.chapter } : {}),
      ...(value.invitedBy.trim() ? { invitedBy: value.invitedBy.trim() } : {}),
      ...classes,
      consent: true,
    };
  }

  function expired() {
    // Temporary identity is never silently replaced, renewed or treated as public.
    revision.current += 1;
    clearResults();
    requestRef.current = null;
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
    // getParticipantStatus validates the participant role, fixed 20h lifetime and server time.
    return status.session;
  }

  async function findSeat(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!open || !slug || busy.current || pendingRef.current) return;
    let input: SearchPayload;
    try {
      input = payload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "請檢查登記資料。");
      return;
    }
    const version = ++revision.current;
    const scope = context;
    clearResults();
    setDirectory(null);
    setDirectoryQuery("");
    busy.current = true;
    setPhase("matching");
    setError(null);
    setNotice(null);
    try {
      const participant = await verifiedAccess(version, scope);
      if (participant === undefined || !current(version, scope)) return;
      const result = await api<unknown>(
        `/public/events/${encodeURIComponent(slug)}/roster-search`,
        "POST",
        input
      );
      if (!current(version, scope)) return;
      const view = searchView(result);
      const after = await verifiedAccess(version, scope);
      if (after === undefined || !current(version, scope)) return;
      if (!sameParticipant(participant, after)) {
        expired();
        return;
      }
      const next: Search = {
        ...view,
        payload: input,
        revision: version,
        context: scope,
        participant: after,
      };
      searchRef.current = next;
      setSearch(next);
    } catch (cause) {
      if (current(version, scope)) setError(requestError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setPhase("idle");
    }
  }

  async function openNameDirectory() {
    if (!open || !slug || busy.current || pendingRef.current) return;
    if (!fieldsRef.current.consent) {
      setError("請先閱讀並同意資料使用說明。");
      return;
    }
    const version = ++revision.current;
    const scope = context;
    clearResults();
    setDirectory(null);
    setDirectoryQuery("");
    busy.current = true;
    setPhase("matching");
    setError(null);
    setNotice(null);
    try {
      const participant = await verifiedAccess(version, scope);
      if (participant === undefined || !current(version, scope)) return;
      const result = await api<unknown>(
        `/public/events/${encodeURIComponent(slug)}/roster-names`,
        "POST",
        { consent: true }
      );
      if (!current(version, scope)) return;
      const view = nameDirectoryView(result);
      const after = await verifiedAccess(version, scope);
      if (after === undefined || !current(version, scope)) return;
      if (!sameParticipant(participant, after)) {
        expired();
        return;
      }
      setDirectory({
        ...view,
        revision: version,
        context: scope,
      });
    } catch (cause) {
      if (current(version, scope)) setError(requestError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setPhase("idle");
    }
  }

  function selectDirectoryName(name: string, snapshot: NameDirectory) {
    if (
      busy.current ||
      directory !== snapshot ||
      !current(snapshot.revision, snapshot.context) ||
      !snapshot.names.includes(name)
    )
      return;
    change({
      name,
      chapter: "",
      invitedBy: "",
      classType: "",
      classNumber: "",
    });
    setDirectory(null);
    setDirectoryQuery("");
    setNotice(
      "已填入姓名。請再查找並核對本人紀錄；選擇姓名不會直接認領或簽到。"
    );
  }

  function selectCandidate(snapshot: Search, match: RosterMatchView | null) {
    if (
      busy.current ||
      searchRef.current !== snapshot ||
      !current(snapshot.revision, snapshot.context) ||
      snapshot.requiresRefinement ||
      (match && !snapshot.candidates.includes(match))
    )
      return;
    const next = { ...snapshot, revision: ++revision.current };
    if (match && requestRef.current?.guestId !== match.guestId)
      requestRef.current = null;
    searchRef.current = next;
    selectionRef.current = match;
    setSearch(next);
    setSelection(match);
    setError(null);
    setNotice(null);
  }

  async function confirmSeat(snapshot: Search, selected: RosterMatchView) {
    if (
      !open ||
      !slug ||
      busy.current ||
      pendingRef.current ||
      searchRef.current !== snapshot ||
      selectionRef.current !== selected ||
      !snapshot.candidates.includes(selected) ||
      snapshot.requiresRefinement ||
      !current(snapshot.revision, snapshot.context)
    )
      return;
    let phone: string;
    try {
      if (!fieldsRef.current.consent)
        throw new Error("請先閱讀並同意資料使用說明。");
      phone = registrationPhone(fieldsRef.current.phone);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "請檢查電話號碼。");
      return;
    }
    const version = snapshot.revision;
    const scope = snapshot.context;
    // Search inputs stay exactly as submitted; never fill filters from API/source fields.
    const body = {
      ...snapshot.payload,
      phone,
      confirmedGuestId: selected.guestId,
      confirmRoster: true,
      rosterSelection: true,
    };
    const signature = JSON.stringify([event.id, slug, body]);
    if (requestRef.current?.signature !== signature) {
      requestRef.current = {
        signature,
        key: idempotencyKey(),
        guestId: selected.guestId,
      };
    }
    const key = requestRef.current.key;
    busy.current = true;
    setPhase("confirming");
    setError(null);
    setNotice(null);
    try {
      const participant = await verifiedAccess(version, scope);
      if (participant === undefined || !current(version, scope)) return;
      if (!sameParticipant(snapshot.participant, participant)) {
        expired();
        return;
      }
      const result = await api<RegistrationResult>(
        `/public/events/${encodeURIComponent(slug)}/register`,
        "POST",
        body,
        key
      );
      if (!current(version, scope)) return;
      // Recheck even for public visitors: a replaced cookie is not the request's owner.
      const after = await verifiedAccess(version, scope);
      if (after === undefined || !current(version, scope)) return;
      if (!sameParticipant(participant, after)) {
        expired();
        return;
      }
      if (
        !result?.guest ||
        result.guest.id !== selected.guestId ||
        !isSafeParticipantInviteToken(result?.invitation?.token)
      ) {
        throw new Error(DESK_ERROR);
      }
      if (after) rememberParticipantInvite(result.invitation.token, after);
      // Keep the invitation capability out of query parameters and public UI/storage.
      window.location.assign(
        `/guest#invite=${encodeURIComponent(result.invitation.token)}`
      );
    } catch (cause) {
      // Exact-body retries (including selected guest ID) retain the same UUID key.
      if (current(version, scope)) setError(requestError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setPhase("idle");
    }
  }

  const visibleSearch =
    search &&
    !accessPending &&
    search.context === context &&
    search.revision === revision.current
      ? search
      : null;
  const visibleDirectory =
    directory &&
    !accessPending &&
    directory.context === context &&
    directory.revision === revision.current
      ? directory
      : null;
  const normalizedDirectoryQuery = directoryQuery
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
  const filteredDirectoryNames = visibleDirectory
    ? visibleDirectory.names.filter(name =>
        name
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(normalizedDirectoryQuery)
      )
    : [];
  const selected =
    visibleSearch && selection && visibleSearch.candidates.includes(selection)
      ? selection
      : null;
  const busyControls = accessPending || phase === "confirming";
  const confirmLabel = event.registrationCheckIn
    ? "是我，確認座位並簽到"
    : "是我，認領座位";
  const id = (suffix: string) => `${inputId}-${suffix}`;

  function details(
    match: RosterMatchView,
    input: SearchPayload,
    showName = true
  ) {
    const sourceClass = [match.classType, match.classNumber]
      .filter(Boolean)
      .join("");
    const submittedClass = [input.classType, input.classNumber]
      .filter(Boolean)
      .join("");
    return (
      <dl className="roster-registration__details">
        {showName && (
          <div>
            <dt>姓名</dt>
            <dd>{match.name}</dd>
          </div>
        )}
        <div>
          <dt>名單行政分組</dt>
          <dd>{match.chapter || "原名單未記錄"}</dd>
        </div>
        <div>
          <dt>班別</dt>
          <dd>
            {sourceClass || (
              <>
                {submittedClass || "你未填寫班別"}
                <p className="event-mobile-help">
                  {submittedClass
                    ? "本人補填；原名單未記錄，確認後才會補記。"
                    : "原名單未記錄班別，不能據此確認是否有班號；知道可補填，不是必填。"}
                </p>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>邀請人</dt>
          <dd>
            {match.invitedBy || (
              <>
                {input.invitedBy || "你未填寫邀請人"}
                <p className="event-mobile-help">
                  {input.invitedBy
                    ? "本人補填；原名單未記錄，確認後才會補記。"
                    : "原名單未記錄邀請人，不能據此確認是否有邀請人；知道可補填，不是必填。"}
                </p>
              </>
            )}
          </dd>
        </div>
      </dl>
    );
  }

  function seat(match: RosterMatchView, compact = false) {
    return (
      <div
        className={
          compact
            ? "roster-registration__candidate-seat"
            : "roster-registration__seat"
        }
        aria-label="預編座位"
      >
        <span>枱號</span>
        <strong>
          {match.table ? `${match.table.number} 號枱` : "尚未編枱"}
        </strong>
        {match.table?.label && <p>{match.table.label}</p>}
        <span>座位</span>
        <strong>
          {match.table?.seat != null
            ? `${match.table.seat} 號位`
            : "待大會安排"}
        </strong>
      </div>
    );
  }

  return (
    <main
      className="event-mobile event-mobile--registration roster-registration"
      style={
        { "--event-accent": event.brand.color || "#c89538" } as CSSProperties
      }
    >
      <header className="event-mobile-hero">
        <span className="event-mobile-eyebrow">
          <Ticket size={14} aria-hidden="true" /> 活動登記
        </span>
        {event.brand.logoUrl && (
          <img
            className="event-mobile-brand-logo"
            src={event.brand.logoUrl}
            alt={`${event.brand.name} 標誌`}
          />
        )}
        <h1>{event.name}</h1>
        <p>
          {formatEventDate(event.date)} · {formatEventVenue(event.venue)}
        </p>
      </header>

      {!open ? (
        <section className="event-mobile-card event-mobile-status">
          <LockKeyhole size={25} aria-hidden="true" />
          <h2>公開登記尚未開放</h2>
          <p>請留意大會公布的登記時間，或到簽到台聯絡工作人員。</p>
        </section>
      ) : (
        <>
          <form
            className="event-mobile-card roster-registration__form"
            name="roster-search"
            onSubmit={findSeat}
            aria-busy={phase !== "idle" || accessPending}
          >
            <div className="event-mobile-card__heading">
              <div>
                <span className="event-mobile-eyebrow">查找座位</span>
                <h2>先用姓名查找</h2>
              </div>
              <CheckCircle2 size={23} aria-hidden="true" />
            </div>
            <p className="event-mobile-help">
              只填姓名並同意資料使用說明即可查找，再在下方選本人。查找不會簽到或新增嘉賓。
            </p>
            <p className="roster-registration__self-check">
              這是自行認領，並非工作人員或電話一次性密碼（OTP）身份驗證。只可選本人紀錄；不確定請到簽到台。
            </p>

            <label className="event-mobile-label" htmlFor={id("name")}>
              姓名
            </label>
            <input
              id={id("name")}
              name="name"
              value={fields.name}
              onChange={e => change({ name: e.target.value })}
              autoComplete="name"
              placeholder="請輸入名單上的姓名"
              maxLength={120}
              required
              disabled={busyControls}
            />

            <label className="event-mobile-label" htmlFor={id("chapter")}>
              分會（可略過）
            </label>
            <select
              id={id("chapter")}
              name="chapter"
              value={fields.chapter}
              onChange={e => change({ chapter: e.target.value })}
              disabled={busyControls}
            >
              <option value="">略過／不確定</option>
              <option value={NO_CHAPTER}>{NO_CHAPTER}</option>
              {chapters.map(chapter => (
                <option key={chapter} value={chapter}>
                  {chapter}
                </option>
              ))}
            </select>

            <details className="roster-registration__supplement">
              <summary>補充班別／邀請人（選填）</summary>
              <label className="event-mobile-label" htmlFor={id("class-type")}>
                班種（可留空）
              </label>
              <select
                id={id("class-type")}
                name="classType"
                value={fields.classType}
                onChange={e =>
                  change({ classType: e.target.value as ClassType | "" })
                }
                disabled={busyControls}
                aria-describedby={id("class-help")}
              >
                <option value="">略過／不確定</option>
                {CLASS_TYPES.map(type => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <label
                className="event-mobile-label"
                htmlFor={id("class-number")}
              >
                班號（可留空）
              </label>
              <input
                id={id("class-number")}
                name="classNumber"
                value={fields.classNumber}
                onChange={e => change({ classNumber: e.target.value })}
                autoComplete="off"
                inputMode="text"
                placeholder={
                  fields.classType
                    ? `例如：62 或 ${fields.classType}62`
                    : "例如：62"
                }
                maxLength={16}
                disabled={busyControls}
                aria-describedby={id("class-help")}
              />
              <p id={id("class-help")} className="event-mobile-help">
                只知道班種或班號也可查找，不清楚可留空。
              </p>

              <label className="event-mobile-label" htmlFor={id("inviter")}>
                邀請人（可留空）
              </label>
              <input
                id={id("inviter")}
                name="invitedBy"
                value={fields.invitedBy}
                onChange={e => change({ invitedBy: e.target.value })}
                placeholder="例如：Sample Guest Lambda／Sample Guest Epsilon／Sample Guest Nu"
                maxLength={120}
                autoComplete="off"
                disabled={busyControls}
                aria-describedby={id("inviter-help")}
              />
              <p id={id("inviter-help")} className="event-mobile-help">
                不清楚可先留空；原名單未記錄時，確認後才補記。已記錄的邀請人仍需核對；無法核對請到簽到台。
              </p>
            </details>

            <label className="event-mobile-check event-mobile-check--consent roster-registration__consent">
              <input
                type="checkbox"
                checked={fields.consent}
                onChange={e => change({ consent: e.target.checked })}
                required
                disabled={busyControls}
                aria-describedby={id("privacy")}
              />
              <span>我已閱讀並同意以下資料使用說明。</span>
            </label>
            <p id={id("privacy")} className="registration-privacy">
              {event.brand.privacyText ||
                "主辦方只會按活動所需處理你提供的資料。"}
            </p>

            {accessPending && (
              <p className="roster-registration__status" role="status">
                正在重新確認登入狀態，暫時不能查找或確認座位。
              </p>
            )}
            {notice && (
              <p className="roster-registration__status" role="status">
                {notice}
              </p>
            )}
            {phase !== "idle" && (
              <p className="roster-registration__status" role="status">
                {phase === "matching"
                  ? "正在查找或讀取名單，請稍候…"
                  : "正在確認座位及登入有效期限，請勿重複提交…"}
              </p>
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
            <button
              type="submit"
              className="event-mobile-primary"
              disabled={
                phase !== "idle" ||
                accessPending ||
                !fields.consent ||
                !fields.name.trim()
              }
            >
              {phase === "matching"
                ? "正在查找…"
                : visibleSearch
                  ? "重新查找座位"
                  : "查找我的座位"}
            </button>
          </form>

          {visibleDirectory && (
            <section
              className="event-mobile-card roster-registration__directory"
              aria-labelledby={id("directory-title")}
            >
              <span className="event-mobile-eyebrow">姓名索引</span>
              <h2 id={id("directory-title")}>所有嘉賓姓名</h2>
              <p className="event-mobile-help">
                以下只顯示姓名，不含電話、分會、邀請人、座位或票號。選擇姓名只會填入查找欄，仍需自行核對本人紀錄。
              </p>
              <label className="event-mobile-label" htmlFor={id("directory-filter")}>
                搜尋名單姓名
              </label>
              <input
                id={id("directory-filter")}
                type="search"
                value={directoryQuery}
                onChange={event => setDirectoryQuery(event.target.value)}
                autoComplete="off"
                placeholder="輸入姓名篩選"
              />
              <p className="roster-registration__status" role="status">
                顯示 {filteredDirectoryNames.length} / {visibleDirectory.names.length} 個姓名
              </p>
              {filteredDirectoryNames.length ? (
                <ul className="roster-registration__directory-list">
                  {filteredDirectoryNames.map((name, index) => (
                    <li key={`${name}-${index}`}>
                      <button
                        type="button"
                        className="roster-registration__directory-name"
                        onClick={() => selectDirectoryName(name, visibleDirectory)}
                        disabled={phase !== "idle" || accessPending}
                      >
                        <span>{name}</span>
                        <span aria-hidden="true">選擇姓名</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="roster-registration__status" role="status">
                  沒有符合這個搜尋字詞的姓名。
                </p>
              )}
              <button
                type="button"
                className="event-mobile-secondary roster-registration__directory-close"
                onClick={() => {
                  setDirectory(null);
                  setDirectoryQuery("");
                }}
              >
                收起名單
              </button>
            </section>
          )}

          {visibleSearch && !selected && (
            <section
              className="event-mobile-card roster-registration__results"
              aria-labelledby={id("results-title")}
            >
              <span className="event-mobile-eyebrow">查找結果</span>
              <h2 id={id("results-title")} ref={resultHeading} tabIndex={-1}>
                在下方選本人
              </h2>
              {visibleSearch.requiresRefinement ? (
                <>
                  <p className="roster-registration__status" role="status">
                    符合的紀錄超過 {ROSTER_CANDIDATE_LIMIT}{" "}
                    位，請補充分會、班別或邀請人再查找；亦可瀏覽所有嘉賓姓名。不清楚請到簽到台。
                  </p>
                  <button
                    type="button"
                    className="event-mobile-secondary roster-registration__directory-toggle"
                    onClick={() => void openNameDirectory()}
                    disabled={phase !== "idle" || accessPending || !fields.consent}
                  >
                    瀏覽所有嘉賓姓名
                  </button>
                </>
              ) : visibleSearch.candidates.length === 0 ? (
                <>
                  <p className="roster-registration__status" role="status">
                    未找到符合的紀錄。請檢查姓名或補充資料再查找；仍未找到可瀏覽所有嘉賓姓名，不會自動新增嘉賓。
                  </p>
                  <button
                    type="button"
                    className="event-mobile-secondary roster-registration__directory-toggle"
                    onClick={() => void openNameDirectory()}
                    disabled={phase !== "idle" || accessPending || !fields.consent}
                  >
                    瀏覽所有嘉賓姓名
                  </button>
                </>
              ) : (
                <>
                  <p className="event-mobile-help">
                    只列出符合姓名及所填資料的紀錄，最多{" "}
                    {ROSTER_CANDIDATE_LIMIT} 位。名單行政分組不代表會員歸屬。
                  </p>
                  <ul className="roster-registration__candidates">
                    {visibleSearch.candidates.map(match => (
                      <li
                        key={match.guestId}
                        className="roster-registration__candidate"
                      >
                        <h3>{match.name}</h3>
                        {details(match, visibleSearch.payload, false)}
                        {seat(match, true)}
                        <button
                          type="button"
                          className="event-mobile-secondary roster-registration__choose"
                          aria-label={`這是我：${match.name}`}
                          disabled={phase !== "idle" || accessPending}
                          onClick={() => selectCandidate(visibleSearch, match)}
                        >
                          這是我
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="event-mobile-help">
                    沒有本人紀錄或資料不符？請補充資料再查找，或到簽到台；不會新增嘉賓。
                  </p>
                </>
              )}
            </section>
          )}

          {visibleSearch && selected && (
            <section
              className="event-mobile-card roster-registration__preview"
              aria-labelledby={id("preview-title")}
              aria-busy={phase === "confirming"}
            >
              <span className="event-mobile-eyebrow">確認前請核對</span>
              <h2 id={id("preview-title")} ref={previewHeading} tabIndex={-1}>
                你選擇了：{selected.name}
              </h2>
              <p className="event-mobile-help">
                名單行政分組不代表會員歸屬。未知資料可在上方補充，不是必填。
              </p>
              {details(selected, visibleSearch.payload)}
              {seat(selected)}
              <p className="roster-registration__self-check">
                按下確認即表示你已自行核對這是本人紀錄；這不是工作人員或電話一次性密碼驗證。
                {event.registrationCheckIn
                  ? "確認後會記錄為已到場。"
                  : "確認只認領座位，不會完成到場簽到。"}
                如資料或座位不符，請勿確認，改到簽到台核對。
              </p>
              <form
                name="roster-confirm"
                onSubmit={e => {
                  e.preventDefault();
                  void confirmSeat(visibleSearch, selected);
                }}
              >
                <label className="event-mobile-label" htmlFor={id("phone")}>
                  電話號碼
                </label>
                <input
                  id={id("phone")}
                  name="phone"
                  type="tel"
                  value={fields.phone}
                  onChange={e => change({ phone: e.target.value })}
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={32}
                  placeholder="8位香港電話；海外電話請加區號"
                  required
                  disabled={busyControls}
                  aria-describedby={id("phone-help")}
                />
                <p id={id("phone-help")} className="event-mobile-help">
                  電話為必填聯絡資料；填寫電話不代表已通過身份驗證。
                </p>
                <button
                  type="submit"
                  className="event-mobile-primary"
                  disabled={
                    phase !== "idle" || accessPending || !fields.phone.trim()
                  }
                >
                  {phase === "confirming" ? "正在確認…" : confirmLabel}
                </button>
                <button
                  type="button"
                  className="event-mobile-secondary roster-registration__edit"
                  disabled={phase !== "idle" || accessPending}
                  onClick={() => selectCandidate(visibleSearch, null)}
                >
                  更換選擇
                </button>
              </form>
              <p className="event-mobile-help">
                不會顯示完整嘉賓名單或任何人的電話。座位安排以大會最新核對為準。
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
