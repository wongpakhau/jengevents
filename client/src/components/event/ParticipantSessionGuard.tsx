import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useContext,
  createContext,
  Fragment,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import type { TemporaryParticipant } from "@shared/participant";
import {
  PARTICIPANT_DEVICE_EVENT,
  PARTICIPANT_INVITE_KEY,
  PARTICIPANT_MARKER_KEY,
  clearParticipantDevice,
  clearParticipantTab,
  createParticipantClock,
  endParticipantSession,
  getParticipantStatus,
  getRememberedParticipant,
  hasParticipantDeviceMarker,
  rememberParticipant,
  type ParticipantClock,
} from "@/lib/participant-session";
import "@/styles/participant-session.css";

const ParticipantAccessPending = createContext(false);
export function useParticipantAccessPending() {
  return useContext(ParticipantAccessPending);
}

type Phase =
  | "checking"
  | "active"
  | "public"
  | "logged-out"
  | "expired"
  | "error";
type SessionState = {
  phase: Phase;
  session: TemporaryParticipant | null;
  remainingMs: number;
  error: string;
};
const initialState: SessionState = {
  phase: "checking",
  session: null,
  remainingMs: 0,
  error: "",
};

/** Shared by the public-route guard and portal, never by staff authorization. */
export function useVerifiedParticipantSession(allowPublic = false) {
  const [state, setState] = useState<SessionState>(initialState);
  const sessionRef = useRef<TemporaryParticipant | null>(null);
  const clockRef = useRef<ParticipantClock | null>(null);
  const hadTemporary = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const expiredRef = useRef(false);
  const mutationRef = useRef(false);

  const expire = useCallback(() => {
    const presence =
      hadTemporary.current ||
      Boolean(sessionRef.current) ||
      hasParticipantDeviceMarker();
    const marker = getRememberedParticipant();
    const replaced = Boolean(
      sessionRef.current && marker && sessionRef.current.id !== marker.id
    );
    generation.current += 1;
    requestRef.current?.abort();
    sessionRef.current = null;
    clockRef.current = null;
    hadTemporary.current = false;
    expiredRef.current = true;
    // Remove children before any later verification can expose an old capability.
    setState({ phase: "expired", session: null, remainingMs: 0, error: "" });
    if (replaced) clearParticipantTab();
    else clearParticipantDevice(presence);
  }, []);

  const verify = useCallback(async () => {
    if (expiredRef.current || mutationRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const requestGeneration = ++generation.current;
    hadTemporary.current ||= hasParticipantDeviceMarker();
    // Keep the instance/draft, not its visible authorization. The rendering
    // layer hides/inerts retained children until this request is verified.
    setState(previous => ({ ...previous, phase: "checking", error: "" }));
    try {
      const status = await getParticipantStatus(controller.signal);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        requestGeneration !== generation.current
      )
        return;
      if (!status.session) {
        if (hadTemporary.current || status.expired) {
          expire();
          return;
        }
        sessionRef.current = null;
        clockRef.current = null;
        setState({
          phase: allowPublic ? "public" : "logged-out",
          session: null,
          remainingMs: 0,
          error: "",
        });
        return;
      }
      const anchor =
        sessionRef.current?.id === status.session.id && clockRef.current
          ? Math.max(Date.parse(status.serverNow), clockRef.current.now())
          : Date.parse(status.serverNow);
      const clock = createParticipantClock(new Date(anchor).toISOString());
      const remainingMs = clock.remaining(status.session);
      if (remainingMs <= 0) {
        expire();
        return;
      }
      const marker = getRememberedParticipant();
      if (
        marker?.id === status.session.id &&
        (marker.issuedAt !== status.session.issuedAt ||
          marker.expiresAt !== status.session.expiresAt)
      )
        throw new Error("臨時身份截止時間不能延長，請重新確認。");
      // Set this before remember emits an in-tab change event to avoid a verify loop.
      sessionRef.current = status.session;
      clockRef.current = clock;
      hadTemporary.current = true;
      rememberParticipant(status.session);
      setState({
        phase: "active",
        session: status.session,
        remainingMs,
        error: "",
      });
    } catch (reason) {
      if (
        !mounted.current ||
        controller.signal.aborted ||
        requestGeneration !== generation.current
      )
        return;
      // Network failure is UNKNOWN, not logout. Never render cached personal content.
      setState({
        phase: "error",
        session: null,
        remainingMs: 0,
        error:
          reason instanceof Error
            ? reason.message
            : "未能驗證臨時登入，請重試。",
      });
    }
  }, [allowPublic, expire]);

  useEffect(() => {
    mounted.current = true;
    hadTemporary.current = hasParticipantDeviceMarker();
    void verify();
    const tick = () => {
      const session = sessionRef.current;
      const clock = clockRef.current;
      if (!session || !clock) return;
      const remainingMs = clock.remaining(session);
      if (remainingMs <= 0) {
        expire();
        return;
      }
      setState(previous =>
        previous.phase === "active" ? { ...previous, remainingMs } : previous
      );
    };
    const timer = window.setInterval(tick, 1000);
    const recheck = () => {
      tick();
      // Expired locally: never renew automatically. Otherwise verify the original cookie.
      if (!expiredRef.current) void verify();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    const onDeviceChange = () => {
      const marker = getRememberedParticipant();
      if (
        !marker &&
        (hadTemporary.current ||
          sessionRef.current ||
          hasParticipantDeviceMarker())
      ) {
        expire();
        return;
      }
      if (
        marker &&
        (marker.id !== sessionRef.current?.id ||
          marker.issuedAt !== sessionRef.current?.issuedAt ||
          marker.expiresAt !== sessionRef.current?.expiresAt)
      ) {
        if (sessionRef.current && marker.id !== sessionRef.current.id) {
          clearParticipantTab();
          sessionRef.current = null;
          clockRef.current = null;
        }
        expiredRef.current = false;
        void verify();
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === PARTICIPANT_MARKER_KEY ||
        event.key === PARTICIPANT_INVITE_KEY
      )
        onDeviceChange();
    };
    window.addEventListener("focus", recheck);
    window.addEventListener("pageshow", recheck);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    window.addEventListener(PARTICIPANT_DEVICE_EVENT, onDeviceChange);
    return () => {
      mounted.current = false;
      generation.current += 1;
      requestRef.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("pageshow", recheck);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PARTICIPANT_DEVICE_EVENT, onDeviceChange);
    };
  }, [expire, verify]);

  // A precise deadline timer complements the countdown and wake-up checks.
  useEffect(() => {
    if (!sessionRef.current || !clockRef.current) return;
    const timeout = window.setTimeout(
      expire,
      clockRef.current.remaining(sessionRef.current)
    );
    return () => window.clearTimeout(timeout);
  }, [state.phase, state.session, expire]);

  const logout = useCallback(async () => {
    if (mutationRef.current) return;
    mutationRef.current = true;
    requestRef.current?.abort();
    const requestGeneration = ++generation.current;
    setState({ phase: "checking", session: null, remainingMs: 0, error: "" });
    try {
      await endParticipantSession();
      if (!mounted.current) return;
      sessionRef.current = null;
      clockRef.current = null;
      hadTemporary.current = false;
      mutationRef.current = false;
      expiredRef.current = false;
      setState({
        phase: "logged-out",
        session: null,
        remainingMs: 0,
        error: "",
      });
    } catch (reason) {
      mutationRef.current = false;
      if (!mounted.current || requestGeneration !== generation.current) return;
      setState({
        phase: "error",
        session: null,
        remainingMs: 0,
        error:
          reason instanceof Error ? reason.message : "登出未獲確認，請重試。",
      });
    }
  }, []);
  return { ...state, retry: verify, logout };
}

/** Wrap /guest and /register/:slug only. Public non-temporary visitors remain public. */
export function ParticipantSessionGuard({ children }: { children: ReactNode }) {
  const participant = useVerifiedParticipantSession(true);
  const [, navigate] = useLocation();
  const retainedIdentity = useRef<string | null>(null);
  const visible =
    participant.phase === "active" || participant.phase === "public";
  if (visible) retainedIdentity.current = participant.session?.id || "public";
  else if (participant.phase !== "checking" && participant.phase !== "error")
    retainedIdentity.current = null;
  useEffect(() => {
    if (participant.phase === "expired" || participant.phase === "logged-out")
      navigate("/participant?expired=1", { replace: true });
  }, [participant.phase, navigate]);
  return (
    <>
      <div hidden={!visible} inert={!visible}>
        <ParticipantAccessPending.Provider value={!visible}>
          {retainedIdentity.current && (
            <Fragment key={retainedIdentity.current}>{children}</Fragment>
          )}
        </ParticipantAccessPending.Provider>
      </div>
      {!visible && (
        <main
          className="participant-page participant-guard"
          aria-busy={participant.phase === "checking"}
        >
          <section className="participant-card">
            <h1>
              {participant.phase === "error"
                ? "暫時未能確認登入"
                : participant.phase === "expired"
                  ? "臨時帳戶已登出"
                  : "正在確認登入狀態…"}
            </h1>
            <p role={participant.phase === "error" ? "alert" : "status"}>
              {participant.phase === "error"
                ? participant.error
                : "確認有效身份後才會顯示活動或個人資料。"}
            </p>
            {participant.phase === "error" && (
              <button
                type="button"
                className="participant-button"
                onClick={() => void participant.retry()}
              >
                重試
              </button>
            )}
          </section>
        </main>
      )}
    </>
  );
}
export default ParticipantSessionGuard;
