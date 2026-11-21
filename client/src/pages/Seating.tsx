import { useState } from "react";
import { Armchair, Check, ChevronRight, Users, Info } from "lucide-react";
import { PageHeading } from "@/components/event/EventShell";
import TableVisual from "@/components/event/TableVisual";
import { demoTables, demoGuests } from "@/lib/event-demo";
export default function Seating() {
  const [selected, setSelected] = useState(1);
  const table = demoTables.find(t => t.id === selected)!;
  return (
    <>
      <PageHeading
        eyebrow="A PLACE FOR EVERY GUEST"
        title="圍枱安排"
        description="將每個名字，安排到最合適的位置。"
        action={
          <span className="soft-badge">
            <Armchair size={16} />
            12 人一圍枱
          </span>
        }
      />
      <div className="seating-toolbar">
        <div className="view-tabs">
          <span className="selected-tab">場地視圖</span>
          <span>12 張圍枱</span>
          <span>112 位已安排</span>
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
      </div>
      <div className="seating-layout">
        <section className="full-floor panel">
          <div className="full-stage">
            <span>主 舞 台</span>
            <small>MAIN STAGE</small>
          </div>
          <div className="full-tables">
            {demoTables.map(t => (
              <TableVisual
                key={t.id}
                table={t}
                selected={t.id === selected}
                onSelect={() => setSelected(t.id)}
              />
            ))}
          </div>
          <div className="full-floor-bottom">
            <span>迎 賓 入 口</span>
            <div>
              商戶展區 <ChevronRight size={14} />
            </div>
          </div>
        </section>
        <aside className="panel table-detail">
          <span className="eyebrow">TABLE DETAILS</span>
          <div className="detail-heading">
            <h2>
              {String(selected).padStart(2, "0")}
              <small>號枱</small>
            </h2>
            <span className="status-pill pending">{table.label}</span>
          </div>
          <div className="detail-metrics">
            <div>
              <strong>
                {table.count}
                <small>/12</small>
              </strong>
              <span>已安排</span>
            </div>
            <div>
              <strong>{table.arrived}</strong>
              <span>已到場</span>
            </div>
            <div>
              <strong>{12 - table.count}</strong>
              <span>空位</span>
            </div>
          </div>
          <h3>
            嘉賓名單示意 <Users size={15} />
          </h3>
          <div className="detail-guests">
            {demoGuests.slice(0, 4).map((g, i) => (
              <div key={g.name}>
                <span className="guest-avatar">{g.name.slice(0, 1)}</span>
                <div>
                  <strong>{g.name}</strong>
                  <small>
                    座位 {String(i + 1).padStart(2, "0")} · 示範嘉賓
                  </small>
                </div>
                {i < 3 ? (
                  <Check size={16} className="text-green" />
                ) : (
                  <span className="small-neutral-dot" />
                )}
              </div>
            ))}
          </div>
          <div className="detail-note">
            <Info size={16} />
            <p>
              此版可點選圍枱查看版面。拖放嘉賓、完整名單與儲存會在視覺確認後接通。
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
