import { describe, expect, it } from "vitest";
import { quickGuestNames } from "./eventflow/quick-registration";
import { listRosterGuestNames } from "./eventflow/roster-match";

const guests = [
  {
    id: "g-1",
    eventId: "event-1",
    tenantId: "tenant-1",
    name: "Zed",
    phone: "9123 4567",
    email: "zed@example.test",
    excludedFromEvent: false,
  },
  {
    id: "g-2",
    eventId: "event-1",
    tenantId: "tenant-1",
    name: "Amy",
    phone: "+852 2123-4567",
    email: "amy@example.test",
    excludedFromEvent: false,
  },
  {
    id: "g-3",
    eventId: "event-1",
    tenantId: "tenant-1",
    name: "No Phone",
    phone: "",
    email: "none@example.test",
    excludedFromEvent: false,
  },
  {
    id: "g-4",
    eventId: "event-1",
    tenantId: "tenant-1",
    name: " amy ",
    phone: "2999 9999",
    email: "duplicate@example.test",
    excludedFromEvent: false,
  },
] as any;

const quickState = {
  event: {
    id: "event-1",
    tenantId: "tenant-1",
    mode: "attendance",
    registrationOpen: true,
    status: "open",
  },
  guests,
  tables: [],
} as any;

const rosterAggregate = {
  event: {
    id: "event-1",
    tenantId: "tenant-1",
    mode: "attendance",
    rosterClaimEnabled: true,
    registrationOpen: true,
    status: "open",
  },
  guests,
  tables: [],
} as any;

describe("public name directories", () => {
  it("defaults to stable name ordering and deduplicates names", () => {
    expect(quickGuestNames(quickState)).toEqual({
      names: ["Amy", "No Phone", "Zed"],
    });
  });

  it("sorts by normalized phone, puts empty phones last, and exposes names only", () => {
    const result = quickGuestNames(quickState, "phone");
    expect(result).toEqual({ names: ["Amy", "Zed", "No Phone"] });
    expect(result).not.toHaveProperty("phones");
    expect(JSON.stringify(result)).not.toContain("9123");
  });

  it("applies the same ordering contract to the roster directory", () => {
    expect(listRosterGuestNames(rosterAggregate, "phone")).toEqual({
      names: ["Amy", "Zed", "No Phone"],
    });
  });
});
