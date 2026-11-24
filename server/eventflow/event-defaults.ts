import { randomUUID } from "node:crypto";
import type { EventInfo } from "../../shared/eventflow";
import type { EventAggregate } from "./engine";

// Extracted verbatim from the current routes.ts defaults. The route should
// import these functions too, so there is a single source of truth going forward.
export function emptyProgram(): EventInfo["program"] {
  return {
    titleEn: "",
    organizationEn: "",
    venueAddress: "",
    receptionTime: "",
    seatingTime: "",
  };
}

export function slugFor(name: string): string {
  const ascii = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `${ascii || "event"}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function defaultEvent(input: {
  id: string;
  tenantId: string;
  name: string;
  date: string;
  venue: string;
  brandName?: string;
  mode?: EventInfo["mode"];
  program?: EventInfo["program"];
}): EventInfo {
  return {
    id: input.id,
    tenantId: input.tenantId,
    name: input.name,
    slug: slugFor(input.name),
    date: input.date,
    venue: input.venue,
    status: "draft",
    mode: input.mode ?? "full",
    program: input.program ?? emptyProgram(),
    brand: {
      name: input.brandName || input.name,
      color: "#C89538",
      logoUrl: "",
      privacyText: "",
    },
    registrationOpen: false,
    registrationCheckIn: false,
    rosterClaimEnabled: false,
    rosterChapters: [],
    thresholdCents: 50_000,
    accumulation: "cumulative",
    ruleVersion: 1,
    excludeWinners: true,
  };
}

export function newAggregate(event: EventInfo): EventAggregate {
  return {
    version: 1,
    event,
    guests: [],
    tables: [],
    merchants: [],
    receipts: [],
    payments: [],
    prizes: [],
    draws: [],
    ledger: [],
    audit: [],
    preorders: [],
  };
}
