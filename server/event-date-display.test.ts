import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EventInfo } from "../shared/eventflow";

// The existing Vitest config uses classic JSX transform, unlike the app build.
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());

const mocks = vi.hoisted(() => ({ workspace: vi.fn() }));
vi.mock("../client/src/contexts/EventWorkspaceContext", () => ({
  useWorkspace: mocks.workspace,
}));
vi.mock("../client/src/_core/hooks/useAuth", () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));
vi.mock("../client/src/components/event/RegistrationQRPanel", () => ({
  default: () => null,
}));

import QuickRosterCheckIn from "../client/src/components/event/QuickRosterCheckIn";
import RosterRegistration from "../client/src/components/event/RosterRegistration";
import AdminOverview from "../client/src/components/event/AdminOverview";
import { CreateFirstEvent } from "../client/src/components/event/WorkspaceGate";

const event: EventInfo = {
  id: "event",
  tenantId: "tenant",
  name: "正向春茗",
  slug: "spring",
  date: "2027-01-31",
  venue: "",
  status: "draft",
  mode: "attendance",
  brand: { name: "Brand", color: "#c89538", logoUrl: "", privacyText: "" },
  program: {
    titleEn: "",
    organizationEn: "",
    venueAddress: "",
    receptionTime: "",
    seatingTime: "",
  },
  registrationOpen: false,
  registrationCheckIn: false,
  thresholdCents: 100000,
  accumulation: "per_transaction",
  ruleVersion: 1,
  excludeWinners: true,
};

describe("event date and venue UI", () => {
  it.each([
    ["active public registration", QuickRosterCheckIn],
    ["legacy public registration", RosterRegistration],
  ])("shows date, pending time and pending venue on %s", (_, Component) => {
    const html = renderToStaticMarkup(
      React.createElement(Component, { event, slug: event.slug })
    );
    expect(html).toContain("2027-01-31");
    expect(html).toContain("時間待定");
    expect(html).toContain("場地待定");
    expect(html).not.toContain("00:00");
    expect(html).not.toContain("GMT");
  });

  it.each([
    ["active public registration", QuickRosterCheckIn],
    ["legacy public registration", RosterRegistration],
  ])("labels explicit and legacy times on %s", (_, Component) => {
    const render = (date: string) =>
      renderToStaticMarkup(
        React.createElement(Component, {
          event: { ...event, date },
          slug: event.slug,
        })
      );
    const instant = render("2027-01-31T10:30:00.000Z");
    expect(instant).toMatch(/瀏覽器當地時間 GMT[+-]/);
    expect(instant).not.toContain("時區未指定");
    const legacy = render("2027-01-31T18:30:00");
    expect(legacy).toContain("2027-01-31 18:30");
    expect(legacy).toContain("時區未指定");
    expect(legacy).not.toContain("瀏覽器當地時間");
  });

  it("shows date, pending time and pending venue on the overview", () => {
    mocks.workspace.mockReturnValue({
      state: {
        event,
        role: "owner",
        guests: [],
        tables: [],
        receipts: [],
        payments: [],
        prizes: [],
        draws: [],
        members: [],
        audit: [],
        merchants: [],
      },
    });
    const html = renderToStaticMarkup(React.createElement(AdminOverview));
    expect(html).toContain("2027-01-31");
    expect(html).toContain("時間待定");
    expect(html).toContain("場地待定");
    expect(html).not.toContain("00:00");
    expect(html).not.toContain("GMT");
  });

  it("does not invent a default date, time or required venue on the creation form", () => {
    mocks.workspace.mockReturnValue({
      session: {
        canCreateEvents: true,
        organizations: [],
        user: { name: "Test", systemRole: "owner" },
      },
      refreshSession: vi.fn(),
      setEventId: vi.fn(),
      error: null,
    });
    const html = renderToStaticMarkup(React.createElement(CreateFirstEvent));
    const date = html.match(/<input[^>]*type="date"[^>]*>/)?.[0] || "";
    const time = html.match(/<input[^>]*type="time"[^>]*>/)?.[0] || "";
    const venue =
      html.match(/<input[^>]*placeholder="例如：Sample Venue"[^>]*>/)?.[0] ||
      "";
    expect(date).toContain("required");
    expect(date).toContain('value=""');
    expect(time).toContain('value=""');
    expect(time).not.toContain("required");
    expect(venue).toContain('value=""');
    expect(venue).not.toContain("required");
    expect(html).toContain("留空表示待定");
  });
});
