import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useRoute } from "wouter";
import { api } from "@/lib/eventflow-api";
import QuickRosterCheckIn from "@/components/event/QuickRosterCheckIn";
import type { EventInfo } from "@shared/eventflow";
import "@/styles/event-mobile.css";

export default function GuestRegistration() {
  const [, params] = useRoute("/register/:slug");
  const slug = params?.slug;
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setEvent(null);
    setLoadError(null);
    setNotFound(false);
    if (!slug) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api<EventInfo>(`/public/events/${encodeURIComponent(slug)}`)
      .then(value => {
        if (!cancelled) setEvent(value);
      })
      .catch(error => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "活動資料暫時無法載入。";
        setLoadError(message);
        setNotFound(/404|not\s*found|找不到/i.test(message));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading)
    return (
      <main className="event-mobile">
        <section
          className="event-mobile-card event-mobile-status"
          role="status"
        >
          <LoaderCircle className="event-mobile-spin" /> 正在讀取活動登記資料…
        </section>
      </main>
    );
  if (!event || !slug)
    return (
      <main className="event-mobile">
        <section
          className="event-mobile-card event-mobile-status event-mobile-status--error"
          role="alert"
        >
          <CircleAlert />
          {notFound ? (
            <>
              <h1>找不到這個活動</h1>
              <p>請檢查大會提供的登記連結。</p>
            </>
          ) : (
            <p>{loadError ?? "活動資料暫時無法載入。"}</p>
          )}
        </section>
      </main>
    );
  return (
    <QuickRosterCheckIn key={`${event.id}:${slug}`} event={event} slug={slug} />
  );
}
