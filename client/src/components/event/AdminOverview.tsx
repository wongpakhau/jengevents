import {
  Armchair,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  MapPin,
  Ticket,
  UserRoundCheck,
  Users,
} from "lucide-react";
import { PageHeading } from "@/components/event/EventShell";
import { money } from "@/lib/eventflow-api";
import { formatEventDate, formatEventVenue } from "@/lib/event-date";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { formatIso } from "./AdminShared";
import RegistrationQRPanel from "./RegistrationQRPanel";
import { eventGuests } from "@shared/eventflow";

export default function AdminOverview() {
  const { state, error: workspaceError, lastUpdatedAt } = useWorkspace();
  if (!state) return null;

  const { event, tables, receipts, payments, prizes, draws } = state;
  const guests = eventGuests(event, state.guests);
  const attendanceOnly = event.mode === "attendance";
  const checkedIn = guests.filter(guest => guest.checkedInAt).length;
  const assigned = guests.filter(
    guest => guest.tableId && guest.seat !== null
  ).length;
  const capacity = tables.reduce((total, table) => total + table.capacity, 0);
  const unassigned = guests.length - assigned;
  const validReceipts = receipts.filter(receipt => receipt.status === "valid");
  const salesCents = validReceipts.reduce(
    (total, receipt) => total + receipt.amountCents,
    0
  );
  const dueCents = validReceipts.reduce(
    (total, receipt) => total + receipt.feeCents,
    0
  );
  const paidCents = payments.reduce(
    (total, payment) => total + payment.amountCents,
    0
  );
  const chances = guests.reduce((total, guest) => total + guest.chances, 0);
  const pendingDraws = draws.filter(draw => !draw.revealedAt).length;

  const stats = attendanceOnly
    ? [
        {
          label: "已到場嘉賓",
          value: checkedIn,
          suffix: `/ ${guests.length}`,
          icon: UserRoundCheck,
          note: "以簽到紀錄為準",
        },
        {
          label: "尚未到場",
          value: Math.max(0, guests.length - checkedIn),
          suffix: "位",
          icon: Users,
          note: "可在簽到台即時搜尋",
        },
        {
          label: "已安排座位",
          value: assigned,
          suffix: `/ ${capacity}`,
          icon: Armchair,
          note: `${tables.length} 張圍枱`,
        },
        {
          label: "待安排座位",
          value: Math.max(0, unassigned),
          suffix: "位",
          icon: CheckCircle2,
          note: "可拖放或取消再安排",
        },
      ]
    : [
        {
          label: "已到場嘉賓",
          value: checkedIn,
          suffix: `/ ${guests.length}`,
          icon: Users,
          note: "以簽到紀錄為準",
        },
        {
          label: "有效消費總額",
          value: money(salesCents),
          suffix: "HKD",
          icon: CircleDollarSign,
          note: `${validReceipts.length} 筆有效憑證`,
        },
        {
          label: "已獲抽獎機會",
          value: chances,
          suffix: "次",
          icon: Ticket,
          note: "由伺服器帳本計算",
        },
        {
          label: "抽獎費餘額",
          value: money(dueCents - paidCents),
          suffix: "HKD",
          icon: CheckCircle2,
          note: `應收 ${money(dueCents)} · 已收 ${money(paidCents)}`,
        },
      ];

  return (
    <>
      <PageHeading
        eyebrow={attendanceOnly ? "CEREMONY ATTENDANCE" : "LIVE EVENT OVERVIEW"}
        title={
          attendanceOnly ? "到場與座位，一目了然。" : "今晚的進度，清楚可見。"
        }
        description={
          attendanceOnly
            ? "此典禮只管理嘉賓、圍枱、簽到和名單匯出；沒有商戶、消費或抽獎功能。"
            : "數字直接來自目前活動紀錄；消費、機會與對帳均以伺服器資料為準。"
        }
      />
      <p className="mvp-data-freshness" role="status">
        已記錄營業額約每 5 秒更新，來源是有效消費憑證；這不是支付平台已收款資料。{" "}
        {lastUpdatedAt
          ? `上次活動資料更新：${formatIso(new Date(lastUpdatedAt).toISOString())}`
          : "正在取得活動資料…"}
        {workspaceError && ` ${workspaceError}`}
      </p>
      <section className="mvp-event-hero">
        <div>
          <span className="mvp-kicker">
            {event.status === "live"
              ? "活動進行中"
              : event.status === "closed"
                ? "活動已結束"
                : "活動籌備中"}
          </span>
          <h2>{event.name}</h2>
          {event.program.titleEn && (
            <p className="mvp-event-en">{event.program.titleEn}</p>
          )}
          <p>
            <CalendarDays size={14} /> {formatEventDate(event.date)}{" "}
            <span>·</span> {formatEventVenue(event.venue)}
          </p>
          {attendanceOnly &&
            (event.program.receptionTime || event.program.seatingTime) && (
              <p className="mvp-event-program">
                {event.program.receptionTime || "恭候時間未設定"}
                {event.program.seatingTime && ` · ${event.program.seatingTime}`}
              </p>
            )}
        </div>
        <div className="mvp-event-hero-mark" aria-hidden="true">
          {event.brand.name.slice(0, 2) || "EF"}
        </div>
      </section>

      <section className="mvp-stat-grid" aria-label="活動即時統計">
        {stats.map(stat => (
          <article className="mvp-stat-card" key={stat.label}>
            <div>
              <span>{stat.label}</span>
              <stat.icon size={18} />
            </div>
            <strong>
              {stat.value}
              <small>{stat.suffix}</small>
            </strong>
            <p>{stat.note}</p>
          </article>
        ))}
      </section>

      <RegistrationQRPanel />

      <section className="mvp-overview-grid">
        <article className="mvp-panel mvp-overview-card">
          <div className="mvp-panel-heading">
            <div>
              <span className="mvp-kicker">SEATING</span>
              <h2>圍枱安排</h2>
            </div>
            <strong>
              {assigned}
              <small> / {capacity || 0}</small>
            </strong>
          </div>
          <div
            className="mvp-progress"
            aria-label={`${assigned} 個已安排座位，共 ${capacity} 個`}
          >
            <i
              style={{
                width: `${capacity ? Math.min(100, (assigned / capacity) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="mvp-key-values">
            <span>{tables.length} 張圍枱</span>
            <span>{Math.max(0, capacity - assigned)} 個可用座位</span>
            <span>{checkedIn} 位已到場</span>
          </div>
        </article>
        {attendanceOnly ? (
          <article className="mvp-panel mvp-overview-card mvp-ceremony-card">
            <div className="mvp-panel-heading">
              <div>
                <span className="mvp-kicker">CEREMONY DETAILS</span>
                <h2>典禮安排</h2>
              </div>
              <MapPin size={20} />
            </div>
            <p>{event.program.organizationEn || event.brand.name}</p>
            <div className="mvp-key-values">
              {event.program.venueAddress && (
                <span>{event.program.venueAddress}</span>
              )}
              {!event.program.venueAddress && (
                <span>可在白牌設定補上完整場地地址</span>
              )}
            </div>
          </article>
        ) : (
          <article className="mvp-panel mvp-overview-card mvp-dark-card">
            <div className="mvp-panel-heading">
              <div>
                <span className="mvp-kicker">DRAW STATUS</span>
                <h2>抽獎進度</h2>
              </div>
              <Ticket size={20} />
            </div>
            <p>
              已建立 {prizes.length} 個獎項，{pendingDraws} 個結果等待舞台揭曉。
            </p>
            <div className="mvp-key-values">
              <span>
                {draws.filter(draw => draw.revealedAt).length} 次已揭曉
              </span>
              <span>未在此頁顯示未揭曉得獎者</span>
            </div>
          </article>
        )}
      </section>

      <section className="mvp-panel mvp-recent-panel">
        <div className="mvp-panel-heading">
          <div>
            <span className="mvp-kicker">RECENT ACTIVITY</span>
            <h2>最近活動紀錄</h2>
          </div>
        </div>
        {state.audit.length ? (
          <ol className="mvp-audit-list">
            {state.audit.slice(0, 7).map(item => (
              <li key={item.id}>
                <div>
                  <strong>{item.action}</strong>
                  <span>{item.detail}</span>
                </div>
                <time>{formatIso(item.createdAt)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <div className="mvp-empty compact">
            <p>目前沒有可顯示的活動紀錄。</p>
          </div>
        )}
      </section>
    </>
  );
}
