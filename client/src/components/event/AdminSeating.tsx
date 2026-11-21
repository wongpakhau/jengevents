import { useRef, useState } from "react";
import {
  Armchair,
  Check,
  Download,
  FileUp,
  Move,
  Plus,
  Users,
  X,
} from "lucide-react";
import type { EventTable, Guest } from "@shared/eventflow";
import { eventGuests } from "@shared/eventflow";
import EliteCeremonyVenueView from "@/components/event/EliteCeremonyVenueView";
import { PageHeading } from "@/components/event/EventShell";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import {
  clampCoordinate,
  downloadText,
  hasRole,
  InlineError,
  guestManagerRoles,
  RoleNotice,
  useWorkspaceMutation,
} from "./AdminShared";

const guestMime = "application/x-eventflow-guest";

type SeatingDraft = {
  ticket: string;
  name: string;
  tableNumber: number;
  tableLabel: string;
  seat: number;
};
type SeatingImportResult = {
  assigned: number;
  createdTables: EventTable[];
};

export default function AdminSeating() {
  const { state, eventId } = useWorkspace();
  const { mutate, isPending, errorFor } = useWorkspaceMutation();
  const canvasRef = useRef<HTMLDivElement>(null);
  const tableDrag = useRef<{
    id: string;
    offsetX: number;
    offsetY: number;
    x: number;
    y: number;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [moving, setMoving] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [tableNumber, setTableNumber] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [seatError, setSeatError] = useState<string | null>(null);
  const [importRows, setImportRows] = useState<SeatingDraft[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [venueMapFailed, setVenueMapFailed] = useState(false);

  if (!state) return null;
  const canManage = hasRole(state.role, guestManagerRoles);
  const guests = eventGuests(state.event, state.guests);
  const selected =
    state.tables.find(table => table.id === selectedId) ??
    state.tables[0] ??
    null;
  const assigned = guests.filter(
    guest => guest.tableId && guest.seat !== null
  ).length;
  const totalCapacity = state.tables.reduce(
    (total, table) => total + table.capacity,
    0
  );
  const unassigned = guests.filter(
    guest => !guest.tableId || guest.seat === null
  );
  const isEliteCeremony = false;
  const showVenueMap = false;

  const assign = async (
    guestId: string,
    tableId: string | null,
    seat: number | null
  ) => {
    const result = await mutate<Guest>(
      `seating-${guestId}`,
      `/events/${eventId}/seating`,
      "POST",
      { guestId, tableId, seat }
    );
    if (result) setSeatError(null);
    return Boolean(result);
  };

  const addTable = async (event: React.FormEvent) => {
    event.preventDefault();
    const number = Number(tableNumber);
    if (!Number.isInteger(number) || number <= 0) {
      setAddError("請輸入正整數枱號。");
      return;
    }
    setAddError(null);
    const result = await mutate<EventTable>(
      "table-create",
      `/events/${eventId}/tables`,
      "POST",
      { number, capacity: 12, x: 50, y: 50 }
    );
    if (result) {
      setShowAdd(false);
      setTableNumber("");
      setSelectedId(result.id);
    }
  };

  const importSeating = async () => {
    if (!importRows.length) {
      setImportError("請先選擇座位表 CSV 檔案。");
      return;
    }
    if (importRows.length > 500) {
      setImportError("一次最多可匯入 500 列座位資料，請分批上載。");
      return;
    }
    setImportError(null);
    const result = await mutate<SeatingImportResult>(
      "seating-import",
      `/events/${eventId}/seating/import`,
      "POST",
      { rows: importRows }
    );
    if (result) {
      setShowImport(false);
      setImportRows([]);
      setImportSummary(
        `已安排 ${result.assigned} 位嘉賓${result.createdTables.length ? `，並建立 ${result.createdTables.length} 張12人圍枱` : ""}。`
      );
    }
  };

  const readSeatFile = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = parseSeatingCsv(await file.text());
      if (!parsed.length) {
        setImportError(
          "找不到有效資料。第一列須包含 ticket 或 name，以及 table_number、seat。"
        );
        return;
      }
      setImportRows(parsed);
      setImportError(null);
    } catch (error) {
      setImportRows([]);
      setImportError(
        error instanceof Error
          ? error.message
          : "CSV 檔案無法讀取，請另存為 UTF-8 CSV 後再試。"
      );
    }
  };

  const readDraggedGuest = (event: React.DragEvent) =>
    event.dataTransfer.getData(guestMime);
  const dropSeat = async (
    event: React.DragEvent,
    table: EventTable,
    seat: number,
    occupied: boolean
  ) => {
    event.preventDefault();
    const guestId = readDraggedGuest(event);
    if (!guestId) return;
    if (occupied) {
      setSeatError("此座位已被安排。請選擇空位；伺服器亦會再次確認座位狀態。");
      return;
    }
    await assign(guestId, table.id, seat);
  };
  const startTableDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    table: EventTable
  ) => {
    if (!canManage) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = table.x ?? 50;
    const y = table.y ?? 50;
    tableDrag.current = {
      id: table.id,
      offsetX: event.clientX - (rect.left + (rect.width * x) / 100),
      offsetY: event.clientY - (rect.top + (rect.height * y) / 100),
      x,
      y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(table.id);
  };
  const trackTableDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!tableDrag.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = clampCoordinate(
      ((event.clientX - tableDrag.current.offsetX - rect.left) / rect.width) *
        100
    );
    const y = clampCoordinate(
      ((event.clientY - tableDrag.current.offsetY - rect.top) / rect.height) *
        100
    );
    tableDrag.current = { ...tableDrag.current, x, y };
    setMoving({ id: tableDrag.current.id, x, y });
  };
  const finishTableDrag = async () => {
    const drag = tableDrag.current;
    tableDrag.current = null;
    setMoving(null);
    if (!drag) return;
    const table = state.tables.find(item => item.id === drag.id);
    if (!table || (table.x === drag.x && table.y === drag.y)) return;
    await mutate<EventTable>(
      `table-position-${drag.id}`,
      `/events/${eventId}/tables/${drag.id}`,
      "PATCH",
      { x: drag.x, y: drag.y }
    );
  };

  return (
    <>
      <PageHeading
        eyebrow="A PLACE FOR EVERY GUEST"
        title="圍枱安排"
        description={showVenueMap
          ? "依宴會廳實際平面圖查看18張圍枱與12席到場狀態；分配由伺服器確認。"
          : "每張枱採 12 位圓桌視圖。可拖放安排或批次匯入座位表；每次寫入均由伺服器原子確認。"}
        action={
          canManage ? (
            <>
              <a
                className="button button-white"
                href={`/api/eventflow/events/${encodeURIComponent(eventId)}/guest-roster.csv`}
              >
                <Download size={15} />
                匯出座位表
              </a>
              <button
                className="button button-white"
                onClick={() => {
                  setImportError(null);
                  setShowImport(true);
                }}
              >
                <FileUp size={15} />
                匯入座位表
              </button>
              <button
                className="button button-dark"
                onClick={() => {
                  setAddError(null);
                  setShowAdd(true);
                }}
              >
                <Plus size={16} />
                新增圍枱
              </button>
            </>
          ) : undefined
        }
      />
      <RoleNotice allowed={guestManagerRoles}>
        {showVenueMap
          ? "你可查看分配狀態；拖放、點選安排、取消座位、批次匯入與新增圍枱需要座位管理權限。場地圖中的圍枱位置按宴會廳平面圖固定。"
          : "你可查看分配狀態；拖放、批次匯入、取消座位、移動圍枱與新增圍枱需要擁有者或管理員。"}
      </RoleNotice>
      {isEliteCeremony && venueMapFailed && (
        <p className="mvp-inline-note" role="alert">
          場地平面圖未能載入，已暫時顯示原有座位視圖；座位資料及安排功能不受影響。
        </p>
      )}
      {importSummary && (
        <p className="mvp-inline-note mvp-import-result" role="status">
          {importSummary}
        </p>
      )}
      {showVenueMap && (
        <EliteCeremonyVenueView
          tables={state.tables}
          guests={guests}
          unassigned={unassigned}
          selected={selected}
          canManage={canManage}
          busy={isPending("seating")}
          totalAssigned={assigned}
          totalCapacity={totalCapacity}
          onSelectTable={setSelectedId}
          onSeatDrop={dropSeat}
          onAssign={assign}
          onUnassign={guest => void assign(guest.id, null, null)}
          onMapError={() => setVenueMapFailed(true)}
        />
      )}
      <section className={`mvp-seating-toolbar${showVenueMap ? " elite-seating-legacy-hidden" : ""}`}>
        <div>
          <strong>
            {assigned}
            <small> / {totalCapacity}</small>
          </strong>
          <span>已安排座位</span>
        </div>
        <div className="mvp-seat-key">
          <span>
            <i className="arrived" />
            已到場
          </span>
          <span>
            <i className="assigned" />
            已安排
          </span>
          <span>
            <i className="empty" />
            空位
          </span>
        </div>
      </section>
      <div className={`mvp-seating-layout${showVenueMap ? " elite-seating-legacy-hidden" : ""}`}>
        <section className="mvp-panel mvp-floor-panel">
          <div className="mvp-floor-stage">
            主 舞 台 <small>MAIN STAGE</small>
          </div>
          <div
            ref={canvasRef}
            className="mvp-floor-canvas"
            onPointerMove={trackTableDrag}
            onPointerUp={() => void finishTableDrag()}
            onPointerCancel={() => void finishTableDrag()}
          >
            {state.tables.map(table => (
              <RoundTable
                key={table.id}
                table={table}
                guests={guests}
                active={selected?.id === table.id}
                position={
                  moving?.id === table.id ? moving : { x: table.x, y: table.y }
                }
                canManage={canManage}
                onSelect={() => setSelectedId(table.id)}
                onDragStart={startTableDrag}
                onSeatDrop={dropSeat}
              />
            ))}
            {!state.tables.length && (
              <div className="mvp-floor-empty">
                <Armchair size={28} />
                <p>尚未建立圍枱。</p>
              </div>
            )}
          </div>
          <div className="mvp-floor-entry">迎 賓 入 口</div>
        </section>
        <aside className="mvp-panel mvp-seating-side">
          <div className="mvp-panel-heading">
            <div>
              <span className="mvp-kicker">UNASSIGNED GUESTS</span>
              <h2>待安排嘉賓</h2>
            </div>
            <strong>{unassigned.length}</strong>
          </div>
          <p className="mvp-side-note">
            將嘉賓拖到圓桌外圈的空座位。座位衝突會由伺服器拒絕，不會覆寫其他安排。
          </p>
          <div className="mvp-unassigned-list">
            {unassigned.map(guest => (
              <button
                key={guest.id}
                className="mvp-drag-guest"
                draggable={canManage}
                onDragStart={event => {
                  event.dataTransfer.setData(guestMime, guest.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
              >
                <span>{guest.name.slice(0, 1)}</span>
                <div>
                  <strong>{guest.name}</strong>
                  <small>{guest.ticket}</small>
                </div>
                <Move size={15} />
              </button>
            ))}
            {!unassigned.length && (
              <div className="mvp-empty compact">
                <Check size={23} />
                <p>所有嘉賓均已安排座位。</p>
              </div>
            )}
          </div>
          {selected && (
            <TableDetails
              table={selected}
              guests={guests}
              canManage={canManage}
              busy={isPending("seating")}
              onUnassign={guest => void assign(guest.id, null, null)}
            />
          )}
        </aside>
      </div>
      <InlineError message={seatError || errorFor("seating")} />
      <InlineError message={errorFor("seating-import")} />
      {state.tables.map(table => (
        <InlineError
          key={table.id}
          message={errorFor(`table-position-${table.id}`)}
        />
      ))}

      {showAdd && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-table-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={() => setShowAdd(false)}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">TABLE SETUP</span>
            <h2 id="add-table-title">新增圍枱</h2>
            <form className="mvp-form" onSubmit={addTable}>
              <label>
                枱號
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={tableNumber}
                  onChange={event => setTableNumber(event.target.value)}
                  placeholder="例如 13"
                />
              </label>
              <label>
                容量
                <input value="12" disabled aria-label="每枱固定容量 12 位" />
              </label>
              <p className="mvp-inline-note">
                此 MVP 採標準 12 人圓桌，座位 1–12 由伺服器鎖定管理。
              </p>
              <InlineError message={addError || errorFor("table-create")} />
              <div className="mvp-dialog-actions">
                <button
                  type="button"
                  className="button button-white"
                  onClick={() => setShowAdd(false)}
                >
                  取消
                </button>
                <button
                  className="button button-dark"
                  disabled={isPending("table-create")}
                >
                  {isPending("table-create") ? "建立中…" : "建立圍枱"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {showImport && (
        <div className="mvp-dialog-backdrop" role="presentation">
          <section
            className="mvp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="seating-import-title"
          >
            <button
              className="mvp-dialog-close"
              aria-label="關閉"
              onClick={() => {
                setShowImport(false);
                setImportRows([]);
                setImportError(null);
              }}
            >
              <X size={18} />
            </button>
            <span className="mvp-kicker">SEATING CSV</span>
            <h2 id="seating-import-title">匯入座位表</h2>
            <p className="mvp-dialog-copy">
              使用 <code>ticket,name,table_number,table_label,seat</code>。
              建議提供票號；姓名只可在活動中唯一時使用。未建立的枱號會自動建立為12人圍枱。
            </p>
            <div className="mvp-upload-row">
              <label className="button button-white">
                <FileUp size={15} />
                選擇 CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={event => void readSeatFile(event.target.files?.[0])}
                  hidden
                />
              </label>
              <button
                className="mvp-text-button"
                onClick={() =>
                  downloadText(
                    "eventflow-seating-template.csv",
                    "ticket,name,table_number,table_label,seat\n000123,測試嘉賓甲,1,主家席,1\n000124,測試嘉賓乙,1,主家席,2\n"
                  )
                }
              >
                下載範本
              </button>
            </div>
            {importRows.length > 0 && (
              <div className="mvp-import-preview">
                <strong>已讀取 {importRows.length} 列座位資料</strong>
                <span>
                  {importRows
                    .slice(0, 3)
                    .map(
                      row =>
                        `${row.name || row.ticket} → ${row.tableNumber}號枱/${row.seat}`
                    )
                    .join("、")}
                  {importRows.length > 3 ? "…" : ""}
                </span>
              </div>
            )}
            <InlineError message={importError || errorFor("seating-import")} />
            <div className="mvp-dialog-actions">
              <button
                className="button button-white"
                onClick={() => setShowImport(false)}
              >
                取消
              </button>
              <button
                className="button button-dark"
                disabled={!importRows.length || isPending("seating-import")}
                onClick={() => void importSeating()}
              >
                {isPending("seating-import")
                  ? "驗證及匯入中…"
                  : `匯入 ${importRows.length || ""} 個座位`}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function RoundTable({
  table,
  guests,
  active,
  position,
  canManage,
  onSelect,
  onDragStart,
  onSeatDrop,
}: {
  table: EventTable;
  guests: Guest[];
  active: boolean;
  position: { x: number; y: number };
  canManage: boolean;
  onSelect: () => void;
  onDragStart: (
    event: React.PointerEvent<HTMLButtonElement>,
    table: EventTable
  ) => void;
  onSeatDrop: (
    event: React.DragEvent,
    table: EventTable,
    seat: number,
    occupied: boolean
  ) => void;
}) {
  const x = clampCoordinate(position.x ?? 50);
  const y = clampCoordinate(position.y ?? 50);
  const assigned = guests.filter(
    guest => guest.tableId === table.id && guest.seat !== null
  );
  return (
    <div
      className={`mvp-round-table ${active ? "active" : ""}`}
      style={{ left: `${x}%`, top: `${y}%` }}
      onClick={onSelect}
    >
      {Array.from({ length: 12 }, (_, index) => {
        const seat = index + 1;
        const angle = ((index * 30 - 90) * Math.PI) / 180;
        const guest = assigned.find(item => item.seat === seat);
        const isUsable = seat <= table.capacity;
        return (
          <button
            type="button"
            key={seat}
            className={`mvp-seat ${guest ? (guest.checkedInAt ? "arrived" : "assigned") : "empty"} ${!isUsable ? "disabled" : ""}`}
            style={{
              left: `${50 + 47 * Math.cos(angle)}%`,
              top: `${50 + 47 * Math.sin(angle)}%`,
            }}
            aria-label={
              isUsable
                ? `座位 ${seat}${guest ? `：${guest.name}` : "，空位"}`
                : `座位 ${seat} 不適用`
            }
            disabled={!isUsable}
            onDragOver={event => {
              if (isUsable) event.preventDefault();
            }}
            onDrop={event => {
              if (isUsable) void onSeatDrop(event, table, seat, Boolean(guest));
            }}
          >
            <span>{guest ? guest.name.slice(0, 1) : seat}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="mvp-table-core"
        onPointerDown={event => onDragStart(event, table)}
        aria-label={`${table.number} 號枱；${assigned.length} 位已安排，${canManage ? "按住拖動位置" : ""}`}
      >
        <small>TABLE</small>
        <strong>{String(table.number).padStart(2, "0")}</strong>
        <span>
          {assigned.length}/{table.capacity}
        </span>
        {canManage && <Move size={12} />}
      </button>
    </div>
  );
}

function TableDetails({
  table,
  guests,
  canManage,
  busy,
  onUnassign,
}: {
  table: EventTable;
  guests: Guest[];
  canManage: boolean;
  busy: boolean;
  onUnassign: (guest: Guest) => void;
}) {
  const assigned = guests
    .filter(guest => guest.tableId === table.id && guest.seat !== null)
    .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
  return (
    <section className="mvp-table-details">
      <div className="mvp-panel-heading">
        <div>
          <span className="mvp-kicker">
            TABLE {String(table.number).padStart(2, "0")}
          </span>
          <h2>{table.label || `${table.number} 號枱`}</h2>
        </div>
        <strong>
          {assigned.length}
          <small>/{table.capacity}</small>
        </strong>
      </div>
      {assigned.length ? (
        <ul>
          {assigned.map(guest => (
            <li key={guest.id}>
              <span
                className={`mvp-seat-person ${guest.checkedInAt ? "arrived" : ""}`}
              >
                {guest.seat}
              </span>
              <div>
                <strong>{guest.name}</strong>
                <small>{guest.checkedInAt ? "已到場" : "未簽到"}</small>
              </div>
              {canManage && (
                <button
                  className="mvp-text-button"
                  disabled={busy}
                  onClick={() => onUnassign(guest)}
                >
                  取消安排
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mvp-side-note">此圍枱暫無已安排嘉賓。</p>
      )}
    </section>
  );
}

function parseSeatingCsv(text: string): SeatingDraft[] {
  const matrix = parseCsv(text).filter(row => row.some(cell => cell.trim()));
  if (matrix.length < 2) return [];
  const headers = matrix[0].map(value =>
    value
      .replace(/^\uFEFF/, "")
      .trim()
      .toLocaleLowerCase()
  );
  const indexOf = (...names: string[]) =>
    headers.findIndex(header => names.includes(header));
  const ticketIndex = indexOf("ticket", "票號");
  const nameIndex = indexOf("name", "嘉賓姓名", "姓名");
  const tableNumberIndex = indexOf("table_number", "table", "枱號", "桌號");
  const tableLabelIndex = indexOf(
    "table_label",
    "table_name",
    "圍枱名稱",
    "枱名"
  );
  const seatIndex = indexOf("seat", "座位", "seat_number");
  if (
    tableNumberIndex === -1 ||
    seatIndex === -1 ||
    (ticketIndex === -1 && nameIndex === -1)
  ) {
    return [];
  }
  return matrix.slice(1).map((row, offset) => {
    const ticket = ticketIndex === -1 ? "" : (row[ticketIndex] ?? "").trim();
    const name = nameIndex === -1 ? "" : (row[nameIndex] ?? "").trim();
    const tableNumber = Number((row[tableNumberIndex] ?? "").trim());
    const seat = Number((row[seatIndex] ?? "").trim());
    if (!ticket && !name) {
      throw new Error(`第 ${offset + 2} 列缺少票號或嘉賓姓名。`);
    }
    if (!Number.isInteger(tableNumber) || tableNumber < 1) {
      throw new Error(`第 ${offset + 2} 列的枱號必須為正整數。`);
    }
    if (!Number.isInteger(seat) || seat < 1 || seat > 12) {
      throw new Error(`第 ${offset + 2} 列的座位必須為1至12。`);
    }
    return {
      ticket,
      name,
      tableNumber,
      tableLabel:
        tableLabelIndex === -1 ? "" : (row[tableLabelIndex] ?? "").trim(),
      seat,
    };
  });
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
