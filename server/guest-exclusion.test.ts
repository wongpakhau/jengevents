import { describe, expect, it } from "vitest";
import { eventGuests, isExcludedFromEvent, type EventInfo, type Guest, type EventTable } from "../shared/eventflow";
import { guestRosterCsv } from "./eventflow/roster";
import { assertSeatChange } from "./eventflow/engine";
import { planSeatingImport } from "./eventflow/seating-import";
import { parseGuestCsv } from "../client/src/components/event/AdminGuests";
const active = { id: "real", name: "Real", ticket: "000001", email: "", phone: "", group: "", note: "", eventId: "event", tenantId: "tenant", tableId: null, seat: null, checkedInAt: null, chances: 0, createdAt: "2026-01-01" } as Guest;
const test = { ...active, id: "test", name: "Retained", ticket: "000002", excludedFromEvent: true, checkedInAt: "2026-01-02" };
const table = { id: "table", eventId: "event", tenantId: "tenant", capacity: 12, number: 1, label: "Table", x: 10, y: 10 } as EventTable;
const event = { mode: "attendance", name: "Ceremony" } as EventInfo;
describe("attendance exclusion shared boundaries", () => {
  it("default false/absent records remain active, all attendance counts exclude retained checked-in tests", () => {
    const guests = eventGuests(event, [active, test, { ...active, id: "legacy", excludedFromEvent: false }]);
    expect(guests).toHaveLength(2); expect(guests.filter(g => g.checkedInAt)).toHaveLength(0);
    expect(isExcludedFromEvent(event, active)).toBe(false);
  });
  it("full mode keeps flagged records in counts and CSV/history", () => {
    const full = { ...event, mode: "full" as const };
    expect(eventGuests(full, [active, test])).toHaveLength(2);
    expect(guestRosterCsv(full, [active, test], [table])).toContain("Retained");
    expect(guestRosterCsv(event, [active, test], [table])).not.toContain("Retained");
  });
  it("attendance seat API blocks retained even when attempting null seat", () => {
    expect(() => assertSeatChange([test], [table], { guestId: "test", tableId: null, seat: null }, "attendance")).toThrow();
    expect(() => assertSeatChange([test], [table], { guestId: "test", tableId: "table", seat: 1 }, "full")).not.toThrow();
  });
  it("attendance seating import name matching ignores retained duplicates but full remains ambiguous", () => {
    const guests = [active, { ...test, name: "Real" }];
    const input = { eventId: "event", tenantId: "tenant", tables: [table], guests, rows: [{ ticket: "", name: "Real", tableNumber: 1, tableLabel: "Table", seat: 1 }] };
    expect(planSeatingImport({ ...input, mode: "attendance" }).assignedGuestIds).toEqual(["real"]);
    expect(() => planSeatingImport({ ...input, mode: "full" })).toThrow();
  });
  it("CSV absence leaves exclusion unspecified for idempotent upserts", () => {
    expect(parseGuestCsv("name,roster_key\nReal,key\n")[0].excludedFromEvent).toBeUndefined();
    expect(parseGuestCsv("name,保留不參會\nTest,是\nReal,false\n").map(g => g.excludedFromEvent)).toEqual([true, false]);
  });
});
