import { Link, useLocation } from "wouter";
import {
  ArrowUpRight,
  ArrowRight,
  Users,
  Ticket,
  Store,
  Wallet,
  CalendarDays,
  MapPin,
  Clock3,
  ScanLine,
  Gift,
  Download,
  ChevronRight,
} from "lucide-react";
import { PageHeading, PanelTitle } from "@/components/event/EventShell";
import TableVisual from "@/components/event/TableVisual";
import {
  demoEvent as event,
  demoTables,
  demoTransactions,
  money,
} from "@/lib/event-demo";

export default function Home() {
  const [, navigate] = useLocation();
  const stats = [
    {
      label: "已到場嘉賓",
      value: event.checkedIn,
      suffix: `/ ${event.guests}`,
      icon: Users,
      note: "到場率 75%",
      progress: 75,
      color: "green",
    },
    {
      label: "商戶消費總額",
      value: `$${money(event.sales)}`,
      suffix: "HKD",
      icon: Store,
      note: "8 個參與商戶",
      color: "gold",
    },
    {
      label: "已領取抽獎機會",
      value: event.chances,
      suffix: "次",
      icon: Ticket,
      note: "每滿 HK$1,000 · 1 次",
      color: "gold",
    },
    {
      label: "大會抽獎費應收",
      value: `$${money(event.sales * 0.1)}`,
      suffix: "HKD",
      icon: Wallet,
      note: "商戶收入的 10%",
      color: "neutral",
    },
  ];
  return (
    <>
      <PageHeading
        eyebrow="YOUR EVENT, AT A GLANCE"
        title="今晚的精彩，一目了然。"
        description="從嘉賓到場到驚喜揭曉，掌握活動的每一個環節。"
        action={
          <>
            <Link className="button button-white" href="/settlements">
              <Download size={15} />
              對帳工作區
            </Link>
            <Link className="button button-dark" href="/checkin">
              <ScanLine size={16} />
              簽到工作區
              <ArrowUpRight size={14} />
            </Link>
          </>
        }
      />
      <section className="event-banner">
        <div className="event-banner-content">
          <span className="mini-label">
            DEMO EVENT <span /> 年度晚宴
          </span>
          <h2>{event.name}</h2>
          <div className="event-meta">
            <span>
              <CalendarDays size={14} />
              {event.date}
            </span>
            <span>
              <Clock3 size={14} />
              {event.time}
            </span>
            <span>
              <MapPin size={14} />
              {event.venue}
            </span>
          </div>
        </div>
        <div className="event-banner-right">
          <div className="banner-monogram">
            E<span>F</span>
          </div>
          <span className="banner-chip">
            12 人一圍枱 <span>·</span> 144 個座位
          </span>
        </div>
      </section>
      <section className="stats-row" aria-label="示範活動數據">
        {stats.map(s => (
          <div className={`stat-card ${s.color}`} key={s.label}>
            <div className="stat-head">
              <span>{s.label}</span>
              <span className="stat-icon">
                <s.icon size={17} strokeWidth={1.6} />
              </span>
            </div>
            <div className="stat-value">
              {s.value}
              <small>{s.suffix}</small>
            </div>
            <div className="stat-foot">
              <span>{s.note}</span>
              {s.progress && (
                <span className="tiny-progress">
                  <i style={{ width: `${s.progress}%` }} />
                </span>
              )}
            </div>
          </div>
        ))}
      </section>
      <div className="overview-middle">
        <section className="panel seating-overview">
          <PanelTitle
            title="座位安排"
            subtitle="每一位嘉賓，都有合適的位置。"
            action={
              <Link className="text-link" href="/seating">
                管理圍枱
                <ArrowUpRight size={14} />
              </Link>
            }
          />
          <div className="seating-overview-body">
            <div className="mini-floor">
              <div className="mini-stage">
                主舞台 <span>MAIN STAGE</span>
              </div>
              <div className="mini-tables">
                {demoTables.slice(0, 6).map(t => (
                  <TableVisual
                    key={t.id}
                    table={t}
                    compact
                    onSelect={() => navigate("/seating")}
                  />
                ))}
              </div>
              <div className="floor-entry">迎賓入口</div>
            </div>
            <div className="seating-summary">
              <div>
                <span className="summary-number">
                  112<small>/ 144</small>
                </span>
                <p>已安排座位</p>
              </div>
              <div className="seat-progress">
                <i />
              </div>
              <div className="seat-legend">
                <span>
                  <i className="green-dot" />
                  已到場
                </span>
                <span>
                  <i className="gold-dot" />
                  已安排
                </span>
                <span>
                  <i className="empty-dot" />
                  空位
                </span>
              </div>
              <div className="summary-bottom">
                <span>12 張圍枱</span>
                <span>32 個空位</span>
              </div>
              <Link href="/seating" className="button button-white">
                開啟座位圖
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </section>
        <section className="draw-teaser">
          <div className="draw-orbit orbit-one" />
          <div className="draw-orbit orbit-two" />
          <div className="draw-orbit orbit-three" />
          <div className="draw-teaser-top">
            <span className="mini-label">THE NEXT BIG MOMENT</span>
            <span className="draw-star">✦</span>
          </div>
          <div className="draw-teaser-content">
            <span className="draw-eyebrow">把期待，留給下一秒。</span>
            <h2>
              下一個幸運兒
              <br />
              會是誰？
            </h2>
            <p>
              專屬大屏幕舞台，讓每次揭曉
              <br />
              都成為全場的共同回憶。
            </p>
          </div>
          <Link href="/screen" className="button button-gold">
            預覽抽獎舞台
            <ArrowUpRight size={16} />
          </Link>
          <span className="draw-teaser-foot">舞台視覺示意 · 非正式抽獎</span>
        </section>
      </div>
      <div className="overview-bottom">
        <section className="panel transactions-panel">
          <PanelTitle
            title="最近消費憑證"
            subtitle="每筆消費，都在累積下一個驚喜。"
            action={
              <Link className="text-link" href="/settlements">
                查看全部
                <ChevronRight size={14} />
              </Link>
            }
          />
          <div className="transaction-table">
            <div className="transaction-header">
              <span>商戶／憑證</span>
              <span>消費金額</span>
              <span>抽獎機會</span>
              <span>領取狀態</span>
            </div>
            {demoTransactions.map(t => (
              <div className="transaction-row" key={t.id}>
                <div className="merchant-cell">
                  <span className="merchant-initial">{t.initials}</span>
                  <div>
                    <strong>{t.merchant}</strong>
                    <small>
                      {t.id} · {t.time}
                    </small>
                  </div>
                </div>
                <strong className="amount">${money(t.amount)}</strong>
                <span className="chance-count">
                  <Ticket size={13} />
                  {t.chances} 次
                </span>
                <span
                  className={`status-pill ${t.claimed ? "success" : "pending"}`}
                >
                  {t.claimed ? "已領取" : "待領取"}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel event-pulse">
          <PanelTitle
            title="嘉賓到場節奏"
            subtitle="掌握迎賓高峰，從容安排。"
          />
          <div className="pulse-value">
            84<small>位已到場嘉賓</small>
            <span>示範趨勢</span>
          </div>
          <div className="pulse-chart" aria-label="示範到場趨勢圖">
            {[15, 24, 32, 50, 73, 94, 85, 66, 48, 31, 19, 12].map((h, i) => (
              <div
                key={i}
                className={i === 5 ? "highlight" : ""}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <div className="chart-labels">
            <span>18:00</span>
            <span>18:30</span>
            <span>19:00</span>
            <span>19:30</span>
          </div>
          <div className="pulse-caption">
            <span className="green-dot" />
            高峰時段：18:30 – 19:00
          </div>
        </section>
      </div>
      <div className="demo-note">
        <Gift size={15} />
        <span>
          你正在查看 v0
          視覺初稿。數據、名單與場地均為虛構；正式簽到、QR領取及收款尚未接通。
        </span>
      </div>
    </>
  );
}
