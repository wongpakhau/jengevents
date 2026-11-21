import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Maximize,
  Minimize,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
  Gift,
  VolumeX,
  Volume2,
  Check,
  Circle,
  ArrowRight,
} from "lucide-react";
import {
  getReelFrame,
  STAGE_DURATION_MS,
  type ReelFrame,
  type StagePhase,
} from "@/lib/stage-sequence";
import { StageSound } from "@/lib/stage-sound";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { api } from "@/lib/eventflow-api";
import type { Draw } from "@shared/eventflow";
import "@/styles/stage-reels.css";

type DisplayPhase = "idle" | StagePhase;
const REEL_DIGITS = Array.from({ length: 40 }, (_, i) => i % 10);
const phaseCopy: Record<
  DisplayPhase,
  { kicker: string; title: string; note: string }
> = {
  idle: {
    kicker: "LUCKY DRAW",
    title: "下一位幸運嘉賓",
    note: "三軸捲動，停定後顯示得獎資訊。",
  },
  charge: { kicker: "READY", title: "三軸啟動", note: "準備揭曉幸運票號。" },
  spinning: {
    kicker: "DRAW IN PROGRESS",
    title: "票號捲動中",
    note: "請稍候。",
  },
  settling: {
    kicker: "REVEALING THE NUMBER",
    title: "票號逐一停定",
    note: "停定後即顯示嘉賓姓名與枱號。",
  },
  winner: {
    kicker: "CONGRATULATIONS",
    title: "恭喜得獎嘉賓",
    note: "得獎票號已揭曉。",
  },
};

export default function Screen() {
  const { state, eventId, reload } = useWorkspace();
  const [winner, setWinner] = useState<Draw | null>(null);
  const activeDraw = useRef<Draw | null>(null);
  const seenDraw = useRef("");
  const revealing = useRef(new Set<string>());
  const latest = [...(state?.draws || [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  )[0];
  const latestRef = useRef<Draw | null>(null);
  latestRef.current = latest || null;
  const [phase, setPhase] = useState<DisplayPhase>("idle");
  const [locked, setLocked] = useState<[boolean, boolean, boolean]>([
    false,
    false,
    false,
  ]);
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundPending, setSoundPending] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState("");
  const reelTracks = useRef<(HTMLDivElement | null)[]>([]);
  const progressTrack = useRef<HTMLSpanElement | null>(null);
  const raf = useRef<number | null>(null);
  const playing = useRef(false);
  const reducedRef = useRef(reduced);
  const sound = useRef<StageSound | null>(null);
  const soundOn = useRef(false);
  const mounted = useRef(true);
  const phaseRef = useRef<DisplayPhase>("idle");
  const locksRef = useRef("000");
  const lastTick = useRef(0);
  const previousPositions = useRef<[number, number, number]>([0, 0, 0]);
  const audioIntent = useRef(0);
  const running = phase !== "idle" && phase !== "winner";
  const copy = phaseCopy[phase];

  const cancel = useCallback(() => {
    playing.current = false;
    if (raf.current !== null) window.cancelAnimationFrame(raf.current);
    raf.current = null;
    sound.current?.stop();
  }, []);

  const paint = useCallback((frame: ReelFrame) => {
    frame.positions.forEach((position, i) => {
      const track = reelTracks.current[i];
      if (!track) return;
      track.style.setProperty(
        "--reel-offset",
        ((((position % 10) + 10) % 10) + 10).toFixed(5)
      );
      track.style.setProperty(
        "--reel-blur",
        !frame.locked[i] && frame.phase === "spinning" ? "1.9px" : "0px"
      );
    });
    progressTrack.current?.style.setProperty(
      "transform",
      `scaleX(${frame.progress})`
    );
  }, []);

  const finish = useCallback(
    (withSound = false) => {
      cancel();
      const draw = activeDraw.current;
      if (!draw) return;
      paint(getReelFrame(STAGE_DURATION_MS, draw.winner.ticket.slice(-3)));
      if (!draw.revealedAt && !revealing.current.has(draw.id)) {
        revealing.current.add(draw.id);
        void api<Draw>(
          `/events/${encodeURIComponent(eventId)}/draws/${draw.id}/reveal`,
          "POST",
          {},
          `reveal-${draw.id}`
        )
          .then(result => {
            if (mounted.current && activeDraw.current?.id === result.id) {
              activeDraw.current = result;
              setWinner(result);
              setNotice("");
            }
            void reload();
          })
          .catch(error => {
            revealing.current.delete(draw.id);
            if (mounted.current)
              setNotice(
                `結果已停定，但公開失敗：${error instanceof Error ? error.message : "請重試"}。再次揭曉不會重新抽獎。`
              );
          });
      }
      phaseRef.current = "winner";
      locksRef.current = "111";
      setPhase("winner");
      setLocked([true, true, true]);
      if (withSound && soundOn.current && !reducedRef.current)
        sound.current?.cue("winner");
    },
    [cancel, paint, eventId, reload]
  );

  useEffect(() => {
    mounted.current = true;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = (event: MediaQueryListEvent) => {
      reducedRef.current = event.matches;
      setReduced(event.matches);
      if (event.matches && playing.current) finish(false);
    };
    const updateFullscreen = () =>
      setFullscreen(Boolean(document.fullscreenElement));
    preference.addEventListener("change", updatePreference);
    document.addEventListener("fullscreenchange", updateFullscreen);
    updateFullscreen();
    return () => {
      mounted.current = false;
      audioIntent.current += 1;
      cancel();
      sound.current?.dispose();
      preference.removeEventListener("change", updatePreference);
      document.removeEventListener("fullscreenchange", updateFullscreen);
    };
  }, [cancel, finish]);

  const start = (resume = false) => {
    if (playing.current) return;
    const draw = latestRef.current;
    if (!draw) return;
    activeDraw.current = draw;
    setWinner(draw);
    cancel();
    setNotice("");
    if (reducedRef.current) {
      finish(false);
      return;
    }
    const age = resume
      ? Math.max(0, Date.now() - Date.parse(draw.createdAt))
      : 0;
    if (age >= STAGE_DURATION_MS) {
      finish(false);
      return;
    }
    const initial = getReelFrame(age, draw.winner.ticket.slice(-3));
    paint(initial);
    setLocked(initial.locked);
    locksRef.current = "000";
    phaseRef.current = initial.phase;
    setPhase(initial.phase);
    playing.current = true;
    previousPositions.current = initial.positions;
    lastTick.current = 0;
    sound.current?.cue("start");
    const started = performance.now() - age;
    const animate = (now: number) => {
      if (!playing.current) return;
      const elapsed = now - started;
      const frame = getReelFrame(elapsed, draw.winner.ticket.slice(-3));
      if (frame.phase === "winner") {
        finish(true);
        return;
      }
      paint(frame);
      if (phaseRef.current !== frame.phase) {
        phaseRef.current = frame.phase;
        setPhase(frame.phase);
      }
      const lockKey = frame.locked.map(value => (value ? "1" : "0")).join("");
      if (locksRef.current !== lockKey) {
        locksRef.current = lockKey;
        setLocked(frame.locked);
        sound.current?.stop();
        sound.current?.cue("lock");
      }
      const moved = frame.positions.some(
        (position, i) =>
          !frame.locked[i] &&
          Math.floor(position) !== Math.floor(previousPositions.current[i])
      );
      if (moved && elapsed > 800 && elapsed - lastTick.current > 95) {
        sound.current?.tick();
        lastTick.current = elapsed;
      }
      previousPositions.current = frame.positions;
      raf.current = window.requestAnimationFrame(animate);
    };
    raf.current = window.requestAnimationFrame(animate);
  };

  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 1000);
    return () => window.clearInterval(timer);
  }, [reload, eventId]);
  useEffect(() => {
    cancel();
    seenDraw.current = "";
    activeDraw.current = null;
    setWinner(null);
    setPhase("idle");
    setLocked([false, false, false]);
  }, [eventId, cancel]);
  useEffect(() => {
    if (!latest || seenDraw.current === latest.id) return;
    seenDraw.current = latest.id;
    if (latest.revealedAt) {
      activeDraw.current = latest;
      setWinner(latest);
      finish(false);
    } else start(true);
  }, [latest?.id, eventId]);

  const toggleSound = async () => {
    const intent = ++audioIntent.current;
    if (soundOn.current || soundPending) {
      soundOn.current = false;
      sound.current?.mute();
      setSoundEnabled(false);
      setSoundPending(false);
      return;
    }
    setSoundPending(true);
    const audio = (sound.current ??= new StageSound());
    try {
      const enabled = await audio.enable();
      if (!enabled || !mounted.current || audioIntent.current !== intent)
        return;
      soundOn.current = true;
      setSoundEnabled(true);
      setNotice("");
    } catch (error) {
      if (mounted.current && audioIntent.current === intent) {
        audio.mute();
        setNotice(
          error instanceof Error
            ? error.message
            : "音效未能啟用，可繼續靜音預覽。"
        );
      }
    } finally {
      if (mounted.current && audioIntent.current === intent)
        setSoundPending(false);
    }
  };

  if (
    !state ||
    !["owner", "admin", "project_manager", "draw"].includes(state.role)
  )
    return (
      <main className="mvp-gate">
        <h1>需要抽獎工作人員權限</h1>
        <Link href="/">返回工作台</Link>
      </main>
    );
  return (
    <div
      className={`stage-page reel-stage ${reduced ? "reduced-motion" : ""}`}
      data-phase={phase}
    >
      <div
        className="stage-background reel-stage-background"
        aria-hidden="true"
      >
        <div className="reel-stage-halo" />
        <div className="stage-ring stage-ring-one" />
        <div className="stage-ring stage-ring-two" />
        <div className="stage-ring stage-ring-three" />
        <div className="stage-ring stage-ring-four" />
      </div>
      <header className="stage-header">
        <Link href="/draw" aria-label="返回抽獎控制台">
          <ArrowLeft size={17} />
          <span>返回控制台</span>
        </Link>
        <div className="stage-brand">
          <img
            src={state.event.brand.logoUrl || "/eventflow-mark.svg"}
            alt=""
            referrerPolicy="no-referrer"
          />
          {state.event.brand.name || "EVENTFLOW"} <span>LIVE STAGE</span>
        </div>
        <button
          className="stage-subtle-button"
          onClick={async () => {
            try {
              if (document.fullscreenElement) await document.exitFullscreen();
              else await document.documentElement.requestFullscreen();
              setNotice("");
            } catch {
              setNotice("此預覽環境未允許全螢幕；仍可直接觀看舞台。");
            }
          }}
        >
          {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          <span>{fullscreen ? "退出全螢幕" : "全螢幕"}</span>
        </button>
      </header>
      <main className="reel-stage-main">
        <div className="stage-event-label">
          <span />
          {state.event.name}
          <span />
        </div>
        <div className="reel-prize">
          <span className="reel-prize-number">01</span>
          <span className="reel-prize-divider" />
          <div>
            <span className="reel-prize-eyebrow">本輪獎項</span>
            <strong>
              <Gift size={18} />
              {winner?.prizeName || latest?.prizeName || "等待大會設定獎項"}
            </strong>
          </div>
        </div>
        <div
          className="reel-copy"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="reel-kicker">{copy.kicker}</span>
          {phase === "winner" ? (
            <>
              <h1 className="reel-winner-name">{winner?.winner.name}</h1>
              <p className="reel-winner-details">
                <span>票號 {winner?.winner.ticket}</span>
                <span />
                {winner?.winner.tableNumber
                  ? `${winner.winner.tableNumber} 號枱`
                  : "未編枱"}
                <span />
                恭喜得獎嘉賓
              </p>
            </>
          ) : (
            <>
              <h1>{copy.title}</h1>
              <p>{copy.note}</p>
            </>
          )}
        </div>
        <section
          className={`reel-machine ${phase === "winner" ? "reel-machine-winner" : ""}`}
          aria-label={
            phase === "winner" ? `得獎票號${winner?.winner.ticket}` : "三軸票號"
          }
        >
          <div className="reel-machine-top">
            <span>
              <Sparkles size={12} />
              LUCKY NUMBER
            </span>
            <span>票號前綴：{winner?.winner.ticket.slice(0, -3) || "—"}</span>
          </div>
          <div className="reel-windows">
            <span
              className="reel-pointer reel-pointer-left"
              aria-hidden="true"
            />
            <span
              className="reel-pointer reel-pointer-right"
              aria-hidden="true"
            />
            {[0, 1, 2].map(i => (
              <div
                className={`reel-column ${locked[i] ? "reel-is-locked" : ""}`}
                key={i}
              >
                <div className="reel-window">
                  <div
                    className="reel-track"
                    ref={element => {
                      reelTracks.current[i] = element;
                    }}
                    aria-hidden="true"
                  >
                    {REEL_DIGITS.map((digit, index) => (
                      <div className="reel-digit" key={index}>
                        {digit}
                      </div>
                    ))}
                  </div>
                  {phase === "idle" && (
                    <span className="reel-idle-digit" aria-hidden="true">
                      —
                    </span>
                  )}
                  <span className="reel-window-shade" aria-hidden="true" />
                  <span className="reel-lock-line" aria-hidden="true" />
                </div>
                <div className="reel-axis-caption">
                  {locked[i] ? <Check size={12} /> : <Circle size={9} />}
                  <span>
                    {locked[i] ? "已停定" : ["百位", "十位", "個位"][i]}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="reel-machine-bottom">
            <span>
              {phase === "winner"
                ? "NUMBER CONFIRMED"
                : phase === "idle"
                  ? "READY"
                  : "DRAW IN PROGRESS"}
            </span>
            <div className="reel-progress" aria-hidden="true">
              <span ref={progressTrack} />
            </div>
            <span>
              {locked.filter(Boolean).length.toString().padStart(2, "0")} / 03
            </span>
          </div>
        </section>
        <div className="reel-action-area">
          {running ? (
            <button
              className="stage-subtle-button reel-skip"
              onClick={() => finish(false)}
            >
              <SkipForward size={15} />
              略過動畫，直接揭曉
            </button>
          ) : (
            <button
              className="stage-play"
              onClick={() => start(false)}
              disabled={!latest}
            >
              {phase === "winner" ? (
                <RotateCcw size={16} />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
              {phase === "winner"
                ? "重播本輪"
                : latest
                  ? "播放本輪"
                  : "等待大會啟動抽獎"}
              {phase === "idle" && <ArrowRight size={16} />}
            </button>
          )}
          <span className="reel-duration">
            {reduced
              ? "減少動態 · 直接揭曉"
              : phase === "winner"
                ? "本輪結果已停定 · 重播不會重抽"
                : "約7秒 · 三軸捲動、減速、停定"}
          </span>
        </div>
        <p className="stage-demo-label">
          <Sparkles size={12} />
          由伺服器確定結果 · 動畫不改變中獎機率
        </p>
        {notice && (
          <p className="reel-notice" role="status">
            {notice}
          </p>
        )}
      </main>
      <footer className="stage-footer">
        <button
          className="reel-sound-button"
          aria-pressed={soundEnabled}
          onClick={toggleSound}
        >
          {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          <span>
            {soundPending
              ? "音效啟用中"
              : soundEnabled
                ? "音效已開啟"
                : "靜音 · 點此啟用音效"}
          </span>
        </button>
        <span>簡單、清晰的現場揭曉。</span>
        <label>
          <input
            type="checkbox"
            checked={reduced}
            onChange={event => {
              reducedRef.current = event.target.checked;
              setReduced(event.target.checked);
              if (event.target.checked && playing.current) finish(false);
            }}
          />
          減少動態效果
        </label>
      </footer>
    </div>
  );
}
