import { randomUUID } from "node:crypto";
import type { EventTable, Guest } from "../../shared/eventflow";
import { eventGuests } from "../../shared/eventflow";
import { assertSeatChange, DomainError } from "./engine";

export type SeatingImportRow = {
  ticket: string;
  name: string;
  tableNumber: number;
  tableLabel: string;
  seat: number;
};

export type SeatingImportPlan = {
  guests: Guest[];
  tables: EventTable[];
  createdTables: EventTable[];
  assignedGuestIds: string[];
};

function autoPosition(index: number) {
  const column = index % 5;
  const row = Math.floor(index / 5) % 4;
  return { x: 12 + column * 19, y: 18 + row * 21 };
}

function resolveGuest(guests: readonly Guest[], row: SeatingImportRow): Guest {
  if (row.ticket) {
    const guest = guests.find(candidate => candidate.ticket === row.ticket);
    if (!guest) {
      throw new DomainError(
        404,
        "GUEST_NOT_FOUND",
        `找不到票號 ${row.ticket} 的嘉賓`
      );
    }
    return guest;
  }
  const matches = guests.filter(candidate => candidate.name === row.name);
  if (!matches.length) {
    throw new DomainError(
      404,
      "GUEST_NOT_FOUND",
      `找不到姓名「${row.name}」的嘉賓`
    );
  }
  if (matches.length > 1) {
    throw new DomainError(
      409,
      "AMBIGUOUS_GUEST_NAME",
      `姓名「${row.name}」有多筆紀錄，請使用票號匯入`
    );
  }
  return matches[0];
}

/**
 * Produces a fully validated replacement seating state without mutating the input.
 * Imported guests are temporarily cleared first, so legitimate seat swaps work in one file.
 */
export function planSeatingImport(input: {
  tenantId: string;
  eventId: string;
  guests: readonly Guest[];
  tables: readonly EventTable[];
  rows: readonly SeatingImportRow[];
  idFactory?: () => string;
  mode?: "full" | "attendance";
}): SeatingImportPlan {
  const idFactory = input.idFactory ?? randomUUID;
  const mode = input.mode ?? "full";
  const resolved = input.rows.map(row => ({
    row,
    guest: resolveGuest(eventGuests({ mode }, input.guests), row),
  }));
  const guestIds = new Set<string>();
  const seats = new Set<string>();
  const labelsByTable = new Map<number, string>();

  for (const { row, guest } of resolved) {
    if (guestIds.has(guest.id)) {
      throw new DomainError(
        409,
        "DUPLICATE_SEATING_GUEST",
        `嘉賓「${guest.name}」在座位檔案出現多次`
      );
    }
    guestIds.add(guest.id);
    const seatKey = `${row.tableNumber}:${row.seat}`;
    if (seats.has(seatKey)) {
      throw new DomainError(
        409,
        "DUPLICATE_SEAT",
        `${row.tableNumber}號枱座位 ${row.seat} 重複`
      );
    }
    seats.add(seatKey);
    const previousLabel = labelsByTable.get(row.tableNumber);
    if (previousLabel && row.tableLabel && previousLabel !== row.tableLabel) {
      throw new DomainError(
        400,
        "TABLE_LABEL_CONFLICT",
        `${row.tableNumber}號枱有不一致的圍枱名稱`
      );
    }
    if (row.tableLabel) labelsByTable.set(row.tableNumber, row.tableLabel);
  }

  const tables = input.tables.map(table => ({ ...table }));
  const createdTables: EventTable[] = [];
  const byNumber = new Map(tables.map(table => [table.number, table]));
  for (const [tableNumber, label] of labelsByTable) {
    const existing = byNumber.get(tableNumber);
    if (!existing || !label || existing.label === label) continue;
    const index = tables.findIndex(table => table.id === existing.id);
    const renamed = { ...existing, label };
    tables[index] = renamed;
    byNumber.set(tableNumber, renamed);
  }
  for (const tableNumber of new Set(
    resolved.map(item => item.row.tableNumber)
  )) {
    if (byNumber.has(tableNumber)) continue;
    const position = autoPosition(tables.length);
    const table: EventTable = {
      id: idFactory(),
      tenantId: input.tenantId,
      eventId: input.eventId,
      number: tableNumber,
      label: labelsByTable.get(tableNumber) || `${tableNumber}號枱`,
      capacity: 12,
      ...position,
    };
    tables.push(table);
    createdTables.push(table);
    byNumber.set(tableNumber, table);
  }

  const guests = input.guests.map(guest =>
    guestIds.has(guest.id)
      ? { ...guest, tableId: null, seat: null }
      : { ...guest }
  );
  for (const { row, guest } of resolved) {
    const table = byNumber.get(row.tableNumber);
    if (!table)
      throw new DomainError(500, "TABLE_STATE_INVALID", "圍枱建立資料不完整");
    assertSeatChange(guests, tables, {
      guestId: guest.id,
      tableId: table.id,
      seat: row.seat,
    }, mode);
    const index = guests.findIndex(candidate => candidate.id === guest.id);
    guests[index] = { ...guests[index], tableId: table.id, seat: row.seat };
  }

  return { guests, tables, createdTables, assignedGuestIds: [...guestIds] };
}
