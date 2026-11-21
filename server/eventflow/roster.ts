import type { EventInfo, EventTable, Guest } from "../../shared/eventflow";
import { eventGuests } from "../../shared/eventflow";

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Avoid spreadsheet formula interpretation in exports that may be opened in Excel.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function guestRosterCsv(
  event: EventInfo,
  guests: readonly Guest[],
  tables: readonly EventTable[]
): string {
  const tableById = new Map(tables.map(table => [table.id, table]));
  const rows = eventGuests(event, guests).sort((left, right) => {
    const group = left.group.localeCompare(right.group, "zh-HK");
    if (group) return group;
    const leftTable = left.tableId
      ? (tableById.get(left.tableId)?.number ?? 9_999)
      : 9_999;
    const rightTable = right.tableId
      ? (tableById.get(right.tableId)?.number ?? 9_999)
      : 9_999;
    if (leftTable !== rightTable) return leftTable - rightTable;
    if ((left.seat ?? 99) !== (right.seat ?? 99))
      return (left.seat ?? 99) - (right.seat ?? 99);
    return left.name.localeCompare(right.name, "zh-HK");
  });

  const header = [
    "活動名稱",
    "嘉賓分組",
    "嘉賓姓名",
    "班種",
    "班號",
    "電郵",
    "電話",
    "票號",
    "枱號",
    "圍枱名稱",
    "座位",
    "簽到狀態",
    "簽到時間",
    "備註",
    "分會",
    "邀請人",
    "類別",
    "名單編號",
    "人工核對",
  ];
  const body = rows.map(guest => {
    const table = guest.tableId ? tableById.get(guest.tableId) : undefined;
    return [
      event.name,
      guest.group,
      guest.name,
      guest.classType || "",
      guest.classNumber || "",
      guest.email,
      guest.phone,
      guest.ticket,
      table ? String(table.number) : "",
      table?.label ?? "",
      guest.seat ? String(guest.seat) : "",
      guest.checkedInAt ? "已到場" : "未到場",
      guest.checkedInAt ?? "",
      guest.note,
      guest.chapter || "",
      guest.invitedBy || "",
      guest.memberKind || "",
      guest.rosterKey || "",
      guest.rosterClaimBlocked ? "是" : "否",
    ]
      .map(csvCell)
      .join(",");
  });

  // Excel on Hong Kong devices recognises the BOM and UTF-8 CJK column names.
  return `\ufeff${header.map(csvCell).join(",")}\n${body.join("\n")}\n`;
}
