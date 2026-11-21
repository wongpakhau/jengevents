import { useState } from "react";
import { Armchair, Camera, FilePenLine, ShoppingBag } from "lucide-react";
import type { GuestView } from "@shared/eventflow";
import { ELITE_MALL_URL, ELITE_PHOTOS_URL } from "@shared/young-friends";
import YoungFriendsApplication from "./YoungFriendsApplication";
import "@/styles/guest-quick-actions.css";

export default function EliteGuestQuickActions({
  table,
}: {
  table: GuestView["table"];
}) {
  const [showSeat, setShowSeat] = useState(true);
  const [showApplication, setShowApplication] = useState(false);
  return (
    <>
      <section
        className="event-mobile-card elite-quick"
        aria-labelledby="elite-quick-heading"
      >
        <div className="elite-quick-heading">
          <h2 id="elite-quick-heading">快速功能</h2>
          <p>今晚的活動，一鍵接續</p>
        </div>
        <div className="elite-quick-grid">
          <button
            type="button"
            className="elite-quick-tile"
            aria-expanded={showSeat}
            aria-controls="elite-my-seat"
            onClick={() => setShowSeat(value => !value)}
          >
            <span className="elite-quick-icon">
              <Armchair size={30} aria-hidden="true" />
            </span>
            <strong>我的座位</strong>
            <small>
              {table
                ? `${table.number} 號枱 · ${table.seat ?? "待安排"} 號位`
                : "待大會安排"}
            </small>
          </button>
          <a
            className="elite-quick-tile"
            href={ELITE_MALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            <span className="elite-quick-icon">
              <ShoppingBag size={30} aria-hidden="true" />
            </span>
            <strong>登記菁英會商城</strong>
            <small>前往商城登入／登記</small>
          </a>
          <a
            className="elite-quick-tile"
            href={ELITE_PHOTOS_URL}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            <span className="elite-quick-icon">
              <Camera size={30} aria-hidden="true" />
            </span>
            <strong>上傳今晚相片</strong>
            <small>前往活動相簿</small>
          </a>
          <button
            type="button"
            className="elite-quick-tile"
            aria-expanded={showApplication}
            aria-controls="elite-friends-form"
            onClick={() => setShowApplication(value => !value)}
          >
            <span className="elite-quick-icon">
              <FilePenLine size={30} aria-hidden="true" />
            </span>
            <strong>申請青聯之友</strong>
            <small>香港島青年聯會</small>
          </button>
        </div>
        <p className="event-mobile-help">
          商城及相簿會在新分頁開啟；不會自動傳送你的嘉賓資料。
        </p>
      </section>
      <section
        id="elite-my-seat"
        hidden={!showSeat}
        className="event-mobile-card elite-seat-card"
        aria-label="我的座位"
      >
        <span>枱號</span>
        <strong>{table ? `${table.number} 號枱` : "待安排"}</strong>
        {table && <p>{table.label}</p>}
        <span>座位</span>
        <strong>{table?.seat ? `${table.seat} 號位` : "待安排"}</strong>
        <p className="event-mobile-help">
          如座位與現場安排不符，請到簽到台核對；以大會最新安排為準。
        </p>
      </section>
      <div id="elite-friends-form">
        {showApplication && (
          <YoungFriendsApplication onClose={() => setShowApplication(false)} />
        )}
      </div>
    </>
  );
}
