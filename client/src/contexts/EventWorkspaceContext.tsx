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
  loading: boolean;
  error: string | null;
};
const Context = createContext<WorkspaceContext | null>(null);
export function EventWorkspaceProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null),
    [state, setState] = useState<WorkspaceState | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
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
    activeEvent = useRef(eventId),
    sessionRef = useRef<Session | null>(null);
  const setEventId = useCallback((id: string) => {
    sequence.current++;
    activeEvent.current = id;
    setState(null);
    setError(null);
    setSelected(id);
    try {
      localStorage.setItem("eventflow-event", id);
    } catch {}
  }, []);
  const refreshSession = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<Session>("/session");
      sessionRef.current = next;
      setSession(next);
      setError(null);
      if (!next.events.some(e => e.id === activeEvent.current)) {
        setEventId(next.events[0]?.id || "");
      }
    } catch (e) {
      setSession(null);
      sessionRef.current = null;
      setState(null);
      setError(
        e instanceof ApiError && e.status === 401
          ? null
          : e instanceof Error
            ? e.message
            : "讀取登入狀態失敗"
      );
    } finally {
      setLoading(false);
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
        setState(next);
        setError(null);
      }
    } catch (e) {
      if (version === sequence.current) {
        setState(null);
        setError(e instanceof Error ? e.message : "活動讀取失敗");
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
        !["/", "/guests", "/checkin"].includes(location.pathname)
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
