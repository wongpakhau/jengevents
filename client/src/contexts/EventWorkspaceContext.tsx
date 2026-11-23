import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { Session, WorkspaceState } from "@shared/eventflow";
import { api, ApiError } from "@/lib/eventflow-api";
type WorkspaceContext = {
  session: Session | null;
  state: WorkspaceState | null;
  eventId: string;
  setEventId: (id: string) => void;
  reload: () => Promise<void>;
  refreshSession: () => Promise<void>;
  lastUpdatedAt: number | null;
  loading: boolean;
  error: string | null;
};
const Context = createContext<WorkspaceContext | null>(null);
export function EventWorkspaceProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null),
    [state, setState] = useState<WorkspaceState | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [eventId, setSelected] = useState(() => {
    try {
      return (
        new URLSearchParams(location.search).get("event") ||
        localStorage.getItem("eventflow-event") ||
        ""
      );
    } catch {
      return "";
    }
  });
  const sequence = useRef(0),
    sessionSequence = useRef(0),
    activeEvent = useRef(eventId),
    sessionRef = useRef<Session | null>(null),
    stateRef = useRef<WorkspaceState | null>(null);
  const setEventId = useCallback((id: string) => {
    sequence.current++;
    activeEvent.current = id;
    stateRef.current = null;
    setState(null);
    setLastUpdatedAt(null);
    setError(null);
    setSelected(id);
    try {
      localStorage.setItem("eventflow-event", id);
    } catch {}
  }, []);
  const refreshSession = useCallback(async () => {
    const version = ++sessionSequence.current;
    sequence.current++;
    // A session refresh can change role or merchant assignment. Invalidate all
    // event-scoped data before the request starts, not after it succeeds.
    sessionRef.current = null;
    stateRef.current = null;
    setState(null);
    setLastUpdatedAt(null);
    setError(null);
    setLoading(true);
    try {
      const next = await api<Session>("/session");
      if (version !== sessionSequence.current) return;
      sessionRef.current = next;
      setSession(next);
      setError(null);
      if (!next.events.some(e => e.id === activeEvent.current)) {
        setLoading(false);
        setEventId(next.events[0]?.id || "");
      }
    } catch (e) {
      if (version !== sessionSequence.current) return;
      setSession(null);
      sessionRef.current = null;
      stateRef.current = null;
      setState(null);
      setLastUpdatedAt(null);
      setError(
        e instanceof ApiError && e.status === 401
          ? null
          : e instanceof Error
            ? e.message
          : "讀取登入狀態失敗"
      );
    } finally {
      if (version === sessionSequence.current) setLoading(false);
    }
  }, [setEventId]);
  const reload = useCallback(async () => {
    const id = activeEvent.current;
    if (!id || !sessionRef.current) return;
    const version = ++sequence.current;
    try {
      const next = await api<WorkspaceState>(
        `/events/${encodeURIComponent(id)}/state`
      );
      if (version === sequence.current && id === activeEvent.current) {
        stateRef.current = next;
        setState(next);
        setError(null);
        setLastUpdatedAt(Date.now());
      }
    } catch (e) {
      if (version === sequence.current) {
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          stateRef.current = null;
          setState(null);
          setLastUpdatedAt(null);
          if (e.status === 401) {
            sessionRef.current = null;
            setSession(null);
          }
          setError(e.message);
          return;
        }
        setError(
          stateRef.current
            ? `資料更新失敗，顯示可能陳舊的資料：${e instanceof Error ? e.message : "活動讀取失敗"}`
            : e instanceof Error
              ? e.message
              : "活動讀取失敗"
        );
      }
    }
  }, []);
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);
  useEffect(() => {
    if (!eventId || !session) return;
    void reload();
  }, [eventId, session, reload]);
  useEffect(() => {
    if (!eventId || !session) return;
    let busy = false;
    let disposed = false;
    const refreshVisibleAttendance = () => {
      if (
        disposed ||
        busy ||
        document.hidden ||
        !["/", "/guests", "/checkin", "/merchants", "/settlements", "/merchant"].includes(location.pathname)
      )
        return;
      busy = true;
      void reload().finally(() => {
        busy = false;
      });
    };
    const timer = window.setInterval(refreshVisibleAttendance, 5_000);
    window.addEventListener("focus", refreshVisibleAttendance);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisibleAttendance);
    };
  }, [eventId, session, reload]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--event-brand",
      state?.event.brand.color || "#c89538"
    );
  }, [state?.event.brand.color]);
  return (
    <Context.Provider
      value={{
        session,
        state,
        eventId,
        setEventId,
        reload,
        refreshSession,
        lastUpdatedAt,
        loading,
        error,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("活動上下文未掛載");
  return value;
}
