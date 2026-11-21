import type { demoTables } from "@/lib/event-demo";
type TableData = (typeof demoTables)[number];
export default function TableVisual({
  table,
  selected = false,
  onSelect,
  compact = false,
}: {
  table: TableData;
  selected?: boolean;
  onSelect?: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`table-visual ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}
      onClick={onSelect}
      aria-label={`選擇${table.id}號枱，${table.count}位嘉賓，${table.arrived}位已到場`}
    >
      <span className="table-ring">
        {Array.from({ length: 12 }, (_, i) => {
          const angle = ((i * 30 - 90) * Math.PI) / 180;
          return (
            <span
              key={i}
              className={`seat-dot ${i < table.arrived ? "arrived" : i < table.count ? "assigned" : "empty"}`}
              style={{
                left: `${50 + 45 * Math.cos(angle)}%`,
                top: `${50 + 45 * Math.sin(angle)}%`,
              }}
            />
          );
        })}
        <span className={`table-center ${table.id < 3 ? "vip" : ""}`}>
          <small>TABLE</small>
          <strong>{String(table.id).padStart(2, "0")}</strong>
          <span>
            {table.count}
            <i>/12</i>
          </span>
        </span>
      </span>
      {!compact && <span className="table-caption">{table.label}</span>}
    </button>
  );
}
