import { useMemo, useState } from "react";
import {
  Armchair,
  Check,
  Focus,
  Search,
  Users,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { EventTable, Guest } from "@shared/eventflow";

const guestMime = "application/x-eventflow-guest";

/** System table numbers map to the numbered table centres printed on the supplied ballroom plan. */
const venuePositions: Record<number, { x: number; y: number; head?: string; venueLabel: string }> = {};

type VenueViewProps = {
  tables: EventTable[];
  guests: Guest[];
  unassigned: Guest[];
  selected: EventTable | null;
  canManage: boolean;
  busy: boolean;
  totalAssigned: number;
  totalCapacity: number;
  onSelectTable: (id: string) => void;
  onSeatDrop: (
    event: React.DragEvent<HTMLButtonElement>,
    table: EventTable,
    seat: number,
    occupied: boolean
  ) => void;
  onAssign: (
    guestId: string,
    tableId: string | null,
    seat: number | null
  ) => Promise<boolean>;
  onUnassign: (guest: Guest) => void;
  onMapError: () => void;
};

export default function EliteCeremonyVenueView({
  tables,
  guests,
  unassigned,
  selected,
  canManage,
  busy,
  totalAssigned,
  totalCapacity,
  onSelectTable,
  onSeatDrop,
  onAssign,
  onUnassign,
  onMapError,
}: VenueViewProps) {
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState("");
  const [placementGuestId, setPlacementGuestId] = useState<string | null>(null);

  const byTable = useMemo(() => {
    const result = new Map<string, Guest[]>();
    for (const guest of guests) {
      if (!guest.tableId || guest.seat === null) continue;
      const current = result.get(guest.tableId) ?? [];
      current.push(guest);
      result.set(guest.tableId, current);
    }
    return result;
  }, [guests]);

  const locatedTables = tables
    .filter(table => venuePositions[table.number])
    .sort((a, b) => a.number - b.number);
  const unlocatedTables = tables
    .filter(table => !venuePositions[table.number])
    .sort((a, b) => a.number - b.number);
  const selectedGuests = selected ? byTable.get(selected.id) ?? [] : [];
  const selectedGuest = unassigned.find(guest => guest.id === placementGuestId) ?? null;
  const filteredUnassigned = unassigned.filter(guest => {
    const term = query.trim().toLocaleLowerCase();
    return !term || guest.name.toLocaleLowerCase().includes(term) || guest.ticket.toLocaleLowerCase().includes(term);
  });
  const checkedIn = guests.filter(guest => guest.checkedInAt).length;
  const emptySeats = Math.max(0, totalCapacity - totalAssigned);

  const setZoomBy = (delta: number) =>
    setZoom(current => Math.min(1.8, Math.max(1, Math.round((current + delta) * 10) / 10)));

  const selectGuest = (guest: Guest) => {
    if (!canManage) return;
    setPlacementGuestId(current => current === guest.id ? null : guest.id);
  };

  const placeSelectedGuest = async (table: EventTable, seat: number) => {
    if (!canManage || !selectedGuest || busy) return;
    const completed = await onAssign(selectedGuest.id, table.id, seat);
    if (completed) setPlacementGuestId(null);
  };

  return (
    <section className="elite-seating-view" aria-label="活動座位圖">
      <div className="elite-seating-summary">
        <div className="elite-seating-title">
          <span className="mvp-kicker">EVENT · VENUE MAP</span>
          <h2>宴會廳席位圖</h2>
          <p>橢圓標示原表／場地枱號。點選圍枱查看12席，安排只在確認後寫入。</p>
        </div>
        <div className="elite-seating-metrics" aria-label="座位摘要">
          <div><strong>{totalAssigned}<small> / {totalCapacity}</small></strong><span>已安排</span></div>
          <div><strong>{checkedIn}</strong><span>已到場</span></div>
          <div><strong>{emptySeats}</strong><span>空位</span></div>
        </div>
      </div>

      <div className="elite-venue-layout">
        <section className="elite-venue-panel" aria-label="宴會廳平面圖">
          <div className="elite-map-toolbar">
            <div>
              <strong>Grand Ballroom</strong>
              <span>Section 1 <i /> Section 2</span>
            </div>
            <div className="elite-map-zoom" aria-label="平面圖縮放">
              <button type="button" onClick={() => setZoomBy(-0.2)} disabled={zoom <= 1} aria-label="縮小場地圖"><ZoomOut size={16} /></button>
              <span>{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={() => setZoomBy(0.2)} disabled={zoom >= 1.8} aria-label="放大場地圖"><ZoomIn size={16} /></button>
              <button type="button" onClick={() => setZoom(1)} disabled={zoom === 1} aria-label="回到全圖"><Focus size={15} /><span>全圖</span></button>
            </div>
          </div>

          <div className="elite-map-viewport" aria-label="可縮放的宴會廳平面圖">
            <div className="elite-map-canvas" style={{ width: `${zoom * 100}%` }}>
              <img
                className="elite-map-image"
                src="/venue/venue-map.png"
                alt="活動場地圖；請在新帳戶設定場地背景圖"
                draggable={false}
                onError={onMapError}
              />
              <div className="elite-map-overlays">
                {locatedTables.map(table => {
                  const point = venuePositions[table.number];
                  const tableGuests = byTable.get(table.id) ?? [];
                  const label = point.head ?? String(table.number).padStart(2, "0");
                  return (
                    <button
                      type="button"
                      key={table.id}
                      className={`elite-map-table ${selected?.id === table.id ? "selected" : ""} ${point.head ? "head-table" : ""}`}
                      style={{ left: `${point.x}%`, top: `${point.y}%` }}
                      onClick={() => onSelectTable(table.id)}
                      aria-pressed={selected?.id === table.id}
                      aria-label={`${point.head ? `${point.head}，` : `${table.number}號枱，`}${tableGuests.length}位已安排、${tableGuests.filter(guest => guest.checkedInAt).length}位已到場、${Math.max(0, table.capacity - tableGuests.length)}個空位`}
                      title={`${point.head ?? `${table.number}號枱`} · ${tableGuests.length}/${table.capacity}`}
                    >
                      {Array.from({ length: 12 }, (_, index) => {
                        const seat = index + 1;
                        const guest = tableGuests.find(item => item.seat === seat);
                        const angle = ((index * 30 - 90) * Math.PI) / 180;
                        return (
                          <i
                            key={seat}
                            className={`elite-map-seat-dot ${guest ? (guest.checkedInAt ? "arrived" : "assigned") : "vacant"}`}
                            style={{ left: `${50 + 43 * Math.cos(angle)}%`, top: `${50 + 43 * Math.sin(angle)}%` }}
                            aria-hidden="true"
                          />
                        );
                      })}
                      <span className="elite-map-table-core">
                        <strong>{label}</strong>
                        <small>{`${tableGuests.length}/${table.capacity}`}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="elite-map-footer">
            <div className="elite-map-legend" aria-label="座位狀態圖例">
              <span><i className="arrived" />已到場</span>
              <span><i className="assigned" />已安排</span>
              <span><i className="vacant" />空位</span>
            </div>
            <span className="elite-map-help">圍枱位置依場地圖固定；桌位座席可由授權人員安排。</span>
          </div>

          {unlocatedTables.length > 0 && (
            <div className="elite-unlocated-tables" role="status">
              <strong>位置待核</strong>
              <span>平面圖沒有對應位置，未自行猜測：</span>
              {unlocatedTables.map(table => (
                <button key={table.id} type="button" onClick={() => onSelectTable(table.id)} aria-pressed={selected?.id === table.id}>
                  {table.label || `枱 ${table.number}`}
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="elite-seating-aside">
          <section className="elite-selected-table">
            {selected ? (
              <>
                <div className="elite-detail-heading">
                  <div>
                    <span className="mvp-kicker">{venuePositions[selected.number]?.head ?? `SYSTEM TABLE ${String(selected.number).padStart(2, "0")}`}</span>
                    <h3>{venuePositions[selected.number]?.head ? `Head Table ${venuePositions[selected.number]?.head?.slice(-1)}` : `${selected.number}號枱`}</h3>
                  </div>
                  <strong>{selectedGuests.length}<small> / {selected.capacity}</small></strong>
                </div>
                <SeatDiagram
                  table={selected}
                  guests={selectedGuests}
                  canManage={canManage}
                  busy={busy}
                  selectedGuest={selectedGuest}
                  onDrop={onSeatDrop}
                  onAssign={placeSelectedGuest}
                />
                <div className="elite-guest-list-title"><strong>本枱嘉賓</strong><span>{selectedGuests.length} 位</span></div>
                {selectedGuests.length ? (
                  <ul className="elite-assigned-guests">
                    {selectedGuests.slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)).map(guest => (
                      <li key={guest.id}>
                        <span className={`elite-seat-number ${guest.checkedInAt ? "arrived" : ""}`}>{guest.seat}</span>
                        <div><strong>{guest.name}</strong><small>{guest.checkedInAt ? "已到場" : "未簽到"}</small></div>
                        {canManage && <button type="button" disabled={busy} onClick={() => onUnassign(guest)}>取消安排</button>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="elite-empty-table">此枱尚未安排嘉賓。</p>}
              </>
            ) : (
              <div className="elite-detail-empty"><Armchair size={24} /><strong>選擇一張圍枱</strong><span>在場地圖點按圍枱，查看12席及嘉賓資料。</span></div>
            )}
          </section>

          <section className="elite-unassigned-panel">
            <div className="elite-unassigned-heading">
              <div><span className="mvp-kicker">UNASSIGNED</span><h3>待安排嘉賓</h3></div>
              <strong>{unassigned.length}</strong>
            </div>
            {selectedGuest && <p className="elite-placement-hint"><Check size={14} /> 已選擇 {selectedGuest.name}，再點本枱空位安排。</p>}
            <label className="elite-guest-search">
              <Search size={15} />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜尋姓名或票號" aria-label="搜尋待安排嘉賓" />
            </label>
            <div className="elite-unassigned-list">
              {filteredUnassigned.map(guest => (
                <button
                  type="button"
                  key={guest.id}
                  className={`elite-unassigned-guest ${placementGuestId === guest.id ? "picked" : ""}`}
                  draggable={canManage}
                  aria-pressed={placementGuestId === guest.id}
                  onClick={() => selectGuest(guest)}
                  onDragStart={event => {
                    if (!canManage) return;
                    event.dataTransfer.setData(guestMime, guest.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <span className="elite-guest-initial">{guest.name.slice(0, 1)}</span>
                  <span className="elite-unassigned-name"><strong>{guest.name}</strong><small>{guest.ticket}</small></span>
                  {placementGuestId === guest.id ? <Check size={16} /> : canManage ? <Users size={15} /> : null}
                </button>
              ))}
              {!filteredUnassigned.length && (
                <div className="elite-unassigned-empty">
                  {unassigned.length ? "沒有符合的嘉賓。" : <><Check size={16} />所有嘉賓均已安排座位。</>}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function SeatDiagram({
  table,
  guests,
  canManage,
  busy,
  selectedGuest,
  onDrop,
  onAssign,
}: {
  table: EventTable;
  guests: Guest[];
  canManage: boolean;
  busy: boolean;
  selectedGuest: Guest | null;
  onDrop: VenueViewProps["onSeatDrop"];
  onAssign: (table: EventTable, seat: number) => void;
}) {
  const guestAtSeat = new Map(guests.map(guest => [guest.seat, guest]));
  return (
    <div className="elite-seat-diagram" aria-label={`${table.number}號枱12席座位圖`}>
      <div className="elite-seat-table-center"><small>{table.number}號枱</small><strong>{venuePositions[table.number]?.head ?? String(table.number).padStart(2, "0")}</strong><span>{guests.length}/{table.capacity} 已安排</span></div>
      {Array.from({ length: 12 }, (_, index) => {
        const seat = index + 1;
        const guest = guestAtSeat.get(seat);
        const angle = ((index * 30 - 90) * Math.PI) / 180;
        const isOccupied = Boolean(guest);
        return (
          <button
            key={seat}
            type="button"
            className={`elite-seat-node ${guest ? (guest.checkedInAt ? "arrived" : "assigned") : "vacant"} ${selectedGuest && !guest ? "drop-target" : ""}`}
            style={{ left: `${50 + 42 * Math.cos(angle)}%`, top: `${50 + 42 * Math.sin(angle)}%` }}
            disabled={!canManage || isOccupied || busy}
            aria-label={`座位 ${seat}${guest ? `，${guest.name}，${guest.checkedInAt ? "已到場" : "未簽到"}` : selectedGuest ? `，空位，點擊安排${selectedGuest.name}` : "，空位"}`}
            title={guest ? `座位 ${seat} · ${guest.name} · ${guest.checkedInAt ? "已到場" : "未簽到"}` : `座位 ${seat} · 空位`}
            onClick={() => {
              if (selectedGuest && !guest) void onAssign(table, seat);
            }}
            onDragOver={event => {
              if (canManage && !isOccupied) event.preventDefault();
            }}
            onDrop={event => {
              if (canManage && !isOccupied) onDrop(event, table, seat, false);
            }}
          >
            <span>{guest ? guest.name.slice(0, 1) : seat}</span>
          </button>
        );
      })}
    </div>
  );
}
