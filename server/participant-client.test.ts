import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PARTICIPANT_COOKIE,
  PARTICIPANT_SESSION_SECONDS,
  type TemporaryParticipant,
} from "../shared/participant";

// All HTTP, browser storage and clock surfaces are fake; never contact production.
type Helpers = typeof import("../client/src/lib/participant-session");
let helper: Helpers;
const ORIGIN = "https://eventflow.example.invalid";
const START = Date.parse("2026-11-08T12:00:00.000Z");
const TTL = PARTICIPANT_SESSION_SECONDS * 1000;
const TOKEN = "a".repeat(43);
const OTHER_TOKEN = "b".repeat(43);
const session: TemporaryParticipant = {
  id: "11c03723-7391-4708-9f68-13c68e08d7d0",
  role: "participant",
  issuedAt: new Date(START).toISOString(),
  expiresAt: new Date(START + TTL).toISOString(),
};
function fakeStorage() {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: vi.fn(() => data.clear()),
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, String(value));
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
    key: (index: number) => [...data.keys()][index] ?? null,
  } satisfies Storage;
}
let local: ReturnType<typeof fakeStorage>;
let tab: ReturnType<typeof fakeStorage>;
let pageUrl: URL;
let fetchMock: ReturnType<typeof vi.fn>;
let dispatch: ReturnType<typeof vi.fn>;
let replaceState: ReturnType<typeof vi.fn>;
let monotonic = 0;
function respond(value: unknown, status = 200, cookie?: string) {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { "set-cookie": cookie } : {}),
        },
      })
  );
}
function validStatus(
  serverNow = new Date(START).toISOString(),
  current = session
) {
  return { session: current, serverNow };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  local = fakeStorage();
  tab = fakeStorage();
  pageUrl = new URL(`${ORIGIN}/participant`);
  dispatch = vi.fn();
  replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
    pageUrl = new URL(url, ORIGIN);
  });
  vi.stubGlobal("window", {
    localStorage: local,
    sessionStorage: tab,
    get location() {
      return pageUrl;
    },
    history: { state: null, replaceState },
    dispatchEvent: dispatch,
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  helper = await import("../client/src/lib/participant-session");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cookie-backed participant HTTP and truthful status", () => {
  it("POSTs empty same-origin JSON with cookies and makes the full 20h deadline reachable", async () => {
    local.setItem("manus-cookie", "old.staff.jwt");
    tab.setItem("manus-cookie", "old.staff.jwt");
    local.setItem("eventflow-pending-staff-invite", "pending");
    tab.setItem("eventflow-pending-staff-invite", "pending");
    respond(
      validStatus(),
      200,
      `${PARTICIPANT_COOKIE}=http-only-test-cookie; Max-Age=${PARTICIPANT_SESSION_SECONDS}; HttpOnly; Secure; SameSite=None`
    );
    expect(await helper.startParticipantSession()).toEqual(validStatus());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/participant/start",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        credentials: "include",
        mode: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(helper.participantNow()).toBe(START);
    expect(Date.parse(session.expiresAt) - helper.participantNow()).toBe(TTL);
    monotonic = TTL - 1;
    vi.setSystemTime(START + TTL - 1);
    expect(Date.parse(session.expiresAt) - helper.participantNow()).toBe(1);
    monotonic = TTL;
    vi.setSystemTime(START + TTL);
    expect(helper.participantNow()).toBe(Date.parse(session.expiresAt));
    for (const store of [local, tab]) {
      expect(store.getItem("manus-cookie")).toBeNull();
      expect(store.getItem("eventflow-pending-staff-invite")).toBeNull();
    }
    const marker = JSON.parse(local.getItem(helper.PARTICIPANT_MARKER_KEY)!);
    expect(marker).toEqual({
      id: session.id,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
    });
    expect(JSON.stringify(marker)).not.toContain("jwt");
    expect(JSON.stringify(marker)).not.toContain("http-only-test-cookie");
    expect(tab.getItem(helper.PARTICIPANT_MARKER_KEY)).toBeNull();
  });
  it("GET never sends staff Authorization, body or identity fields", async () => {
    tab.setItem("manus-cookie", "webdev_app_session=staff-jwt");
    respond(validStatus());
    await helper.getParticipantStatus();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/participant/session");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "include",
      mode: "same-origin",
      cache: "no-store",
    });
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(helper.getRememberedParticipant()).toBeNull();
  });
  it("a real logged-out status stays null, never inventing a temp identity", async () => {
    respond({ session: null, serverNow: new Date(START).toISOString() });
    expect((await helper.getParticipantStatus()).session).toBeNull();
    expect(helper.getRememberedParticipant()).toBeNull();
    await expect(helper.startParticipantSession()).rejects.toThrow("未能建立");
  });
  it("unknown network state is an error, not logout, and does not erase a valid marker", async () => {
    helper.rememberParticipant(session);
    fetchMock.mockRejectedValue(new TypeError("network unavailable"));
    await expect(helper.getParticipantStatus()).rejects.toThrow(
      "network unavailable"
    );
    expect(helper.getRememberedParticipant()?.id).toBe(session.id);
  });
  it("times out a deferred revalidation without inventing logout or extending its deadline", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(START);
    helper.rememberParticipant(session);
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const pending = helper.getParticipantStatus();
    const failure = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(helper.getRememberedParticipant()?.expiresAt).toBe(
      session.expiresAt
    );
  });
  it.each([401, 403, 429, 503])(
    "HTTP %i is never converted into a successful logout",
    async status => {
      helper.rememberParticipant(session);
      respond(
        { session: null, serverNow: new Date(START).toISOString() },
        status
      );
      await expect(helper.getParticipantStatus()).rejects.toThrow(
        String(status)
      );
      expect(helper.getRememberedParticipant()?.id).toBe(session.id);
    }
  );
  it("bad JSON is not interpreted as unauthenticated", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>bad gateway</html>", { status: 200 })
    );
    await expect(helper.getParticipantStatus()).rejects.toThrow("回應不正確");
  });
  it("failed start preserves old staff fallback and pending invite until success", async () => {
    tab.setItem("manus-cookie", "old");
    tab.setItem("eventflow-pending-staff-invite", "pending");
    respond(
      validStatus(new Date(START).toISOString(), {
        ...session,
        role: "staff",
      } as unknown as TemporaryParticipant)
    );
    await expect(helper.startParticipantSession()).rejects.toThrow();
    expect(tab.getItem("manus-cookie")).toBe("old");
    expect(tab.getItem("eventflow-pending-staff-invite")).toBe("pending");
  });
  it("logout POST is confirmed before clearing device data", async () => {
    helper.rememberParticipant(session);
    helper.rememberParticipantInvite(TOKEN, session);
    respond({ success: true });
    await helper.endParticipantSession();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/participant/logout",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        credentials: "include",
        mode: "same-origin",
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(helper.getRememberedParticipant()).toBeNull();
    expect(local.getItem(helper.PARTICIPANT_INVITE_KEY)).toBeNull();
  });
  it("a failed logout cannot pretend that the server session ended", async () => {
    helper.rememberParticipant(session);
    respond(validStatus());
    await expect(helper.endParticipantSession()).rejects.toThrow("未確認登出");
    expect(helper.getRememberedParticipant()?.id).toBe(session.id);
  });
});

describe("strict role, expiry and response validation", () => {
  it.each(["staff", "owner", "admin", "user", "guest", "temporary", null])(
    "rejects non-participant role %s",
    role => {
      expect(() =>
        helper.validateParticipantStatus({
          ...validStatus(),
          session: { ...session, role },
        })
      ).toThrow();
    }
  );
  it.each([
    { expiresAt: "not-a-date" },
    { expiresAt: new Date(START + TTL + 1000).toISOString() },
    { expiresAt: new Date(START + TTL - 1000).toISOString() },
    { expiresAt: session.issuedAt },
    { expiresAt: START + TTL },
    { issuedAt: "2026-11-08" },
    { id: "../staff" },
    { id: "" },
  ])("rejects malformed/non-20h session %j", overrides => {
    expect(() =>
      helper.validateParticipantStatus({
        ...validStatus(),
        session: { ...session, ...overrides },
      })
    ).toThrow();
  });
  it("rejects expiry exactly at serverNow and future-issued identity", () => {
    expect(() =>
      helper.validateParticipantStatus(validStatus(session.expiresAt))
    ).toThrow();
    expect(() =>
      helper.validateParticipantStatus(
        validStatus(new Date(START - 1).toISOString())
      )
    ).toThrow();
  });
  it.each([
    undefined,
    {},
    [],
    { session: null },
    { session: null, serverNow: "today" },
    { session: null, serverNow: session.issuedAt, expired: "yes" },
    { ...validStatus(), expired: true },
  ])("rejects invalid status %j", invalid => {
    expect(() => helper.validateParticipantStatus(invalid)).toThrow();
  });
  it("strips extra personal/authentication fields out of validated identity", () => {
    const result = helper.validateParticipantStatus({
      ...validStatus(),
      session: {
        ...session,
        name: "Never stored",
        token: "never",
        isStaff: true,
      },
    });
    expect(result.session).toEqual(session);
    helper.rememberParticipant(result.session!);
    expect(local.getItem(helper.PARTICIPANT_MARKER_KEY)).not.toMatch(
      /name|token|isStaff|role/
    );
  });
  it("accepts explicit expired logged-out status without fabricating a session", () => {
    expect(
      helper.validateParticipantStatus({
        session: null,
        serverNow: session.expiresAt,
        expired: true,
      })
    ).toMatchObject({ session: null, expired: true });
  });
});

describe("non-rolling markers, own invitation and scoped cleanup", () => {
  it("GET/reusing start do not rewrite the marker or erase registered own capability", async () => {
    respond(validStatus());
    await helper.startParticipantSession();
    helper.rememberParticipantInvite(TOKEN, session);
    local.setItem("eventflow.guest-invite", TOKEN);
    tab.setItem("eventflow.guest-invite", TOKEN);
    const original = local.getItem(helper.PARTICIPANT_MARKER_KEY);
    local.setItem.mockClear();
    monotonic = 3600000;
    vi.setSystemTime(START + 3600000);
    respond(validStatus(new Date(START + 3600000).toISOString()));
    const status = await helper.getParticipantStatus();
    helper.rememberParticipant(status.session!);
    await helper.startParticipantSession();
    expect(local.getItem(helper.PARTICIPANT_MARKER_KEY)).toBe(original);
    expect(local.setItem).not.toHaveBeenCalledWith(
      helper.PARTICIPANT_MARKER_KEY,
      expect.anything()
    );
    expect(helper.participantInvitePath(session)).toBe(
      `/guest#invite=${TOKEN}`
    );
    expect(local.getItem("eventflow.guest-invite")).toBe(TOKEN);
    expect(tab.getItem("eventflow.guest-invite")).toBe(TOKEN);
  });
  it("same id cannot extend or alter its fixed issuance/deadline", () => {
    helper.rememberParticipant(session);
    helper.rememberParticipantInvite(TOKEN, session);
    const shifted = {
      ...session,
      issuedAt: new Date(START + 1000).toISOString(),
      expiresAt: new Date(START + TTL + 1000).toISOString(),
    };
    expect(() => helper.rememberParticipant(shifted)).toThrow("不能延長");
    expect(helper.getRememberedParticipant()?.expiresAt).toBe(
      session.expiresAt
    );
    expect(helper.participantInvitePath(session)).toBe(
      `/guest#invite=${TOKEN}`
    );
  });
  it("a fresh first start clears old guest-invite but not unrelated guest storage", async () => {
    local.setItem("eventflow.guest-invite", OTHER_TOKEN);
    tab.setItem("eventflow.guest-invite", OTHER_TOKEN);
    local.setItem("eventflow.guest-preference", "keep");
    respond(validStatus());
    await helper.startParticipantSession();
    expect(local.getItem("eventflow.guest-invite")).toBeNull();
    expect(tab.getItem("eventflow.guest-invite")).toBeNull();
    expect(local.getItem("eventflow.guest-preference")).toBe("keep");
  });
  it("new id clears old temporary invitation and generic guest-invite in both stores", async () => {
    helper.rememberParticipant(session);
    helper.rememberParticipantInvite(TOKEN, session);
    local.setItem("eventflow.guest-invite", TOKEN);
    tab.setItem("eventflow.guest-invite", TOKEN);
    const next = { ...session, id: "38f582ad-9fe0-4214-a6b7-8af42c5af39b" };
    respond(validStatus(session.issuedAt, next));
    await helper.startParticipantSession();
    expect(helper.getRememberedParticipant()?.id).toBe(next.id);
    expect(helper.participantInvitePath(next)).toBeNull();
    expect(local.getItem("eventflow.guest-invite")).toBeNull();
    expect(tab.getItem("eventflow.guest-invite")).toBeNull();
  });
  it("saved invite binds sid and expiry and returns a fragment, never token query", () => {
    helper.rememberParticipant(session);
    helper.rememberParticipantInvite(TOKEN, session);
    expect(JSON.parse(local.getItem(helper.PARTICIPANT_INVITE_KEY)!)).toEqual({
      sid: session.id,
      expiresAt: session.expiresAt,
      token: TOKEN,
    });
    expect(helper.participantInvitePath(session)).toBe(
      `/guest#invite=${TOKEN}`
    );
    expect(
      helper.participantInvitePath({ ...session, id: "another-session" })
    ).toBeNull();
    expect(
      helper.participantInvitePath({
        ...session,
        role: "staff",
      } as unknown as TemporaryParticipant)
    ).toBeNull();
    expect(helper.participantInvitePath(session)).not.toContain("?");
  });
  it("expired invite cannot be returned or saved again", () => {
    helper.rememberParticipant(session);
    helper.rememberParticipantInvite(TOKEN, session);
    vi.setSystemTime(START + TTL);
    expect(helper.participantInvitePath(session)).toBeNull();
    expect(() => helper.rememberParticipantInvite(TOKEN, session)).toThrow();
  });
  it.each([
    "",
    "short",
    "https://evil.invalid",
    "javascript:alert(1)",
    "x".repeat(44),
    "a".repeat(42) + ".",
  ])("rejects unsafe capability %s", token => {
    helper.rememberParticipant(session);
    expect(() => helper.rememberParticipantInvite(token, session)).toThrow();
  });
  it("cannot remember an invite without matching device marker", () => {
    expect(() => helper.rememberParticipantInvite(TOKEN, session)).toThrow();
    helper.rememberParticipant(session);
    expect(() =>
      helper.rememberParticipantInvite(TOKEN, { ...session, id: "different" })
    ).toThrow();
  });
  it("temporary expiry removes scoped data and invite/claim fragments only", () => {
    pageUrl = new URL(
      `${ORIGIN}/guest#invite=${TOKEN}&claim=${OTHER_TOKEN}&section=receipt`
    );
    helper.rememberParticipant(session);
    helper.rememberParticipantInvite(TOKEN, session);
    local.setItem("eventflow.guest-invite", TOKEN);
    tab.setItem("eventflow.guest-invite", TOKEN);
    local.setItem("eventflow.guest-other", "keep-local");
    tab.setItem("eventflow.guest-other", "keep-tab");
    helper.clearParticipantDevice();
    expect(helper.getRememberedParticipant()).toBeNull();
    expect(local.getItem(helper.PARTICIPANT_INVITE_KEY)).toBeNull();
    expect(local.getItem("eventflow.guest-invite")).toBeNull();
    expect(tab.getItem("eventflow.guest-invite")).toBeNull();
    expect(local.getItem("eventflow.guest-other")).toBe("keep-local");
    expect(tab.getItem("eventflow.guest-other")).toBe("keep-tab");
    expect(pageUrl.hash).toBe("#section=receipt");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: helper.PARTICIPANT_DEVICE_EVENT })
    );
  });
  it("without temporary presence, normal guest storage and fragment are not removed", () => {
    pageUrl = new URL(`${ORIGIN}/guest#invite=${TOKEN}`);
    local.setItem("eventflow.guest-invite", TOKEN);
    tab.setItem("eventflow.guest-invite", TOKEN);
    helper.clearParticipantDevice();
    expect(local.getItem("eventflow.guest-invite")).toBe(TOKEN);
    expect(tab.getItem("eventflow.guest-invite")).toBe(TOKEN);
    expect(pageUrl.hash).toBe(`#invite=${TOKEN}`);
  });
  it("a removed cross-tab marker cannot fall back to stale in-memory identity", () => {
    helper.rememberParticipant(session);
    helper.rememberParticipantInvite(TOKEN, session);
    local.removeItem(helper.PARTICIPANT_MARKER_KEY);
    local.removeItem(helper.PARTICIPANT_INVITE_KEY);
    expect(helper.getRememberedParticipant()).toBeNull();
    expect(helper.hasParticipantDeviceMarker()).toBe(false);
    expect(helper.participantInvitePath(session)).toBeNull();
    // Guard passes previous temporary presence on remote logout to clear tab-local data too.
    tab.setItem("eventflow.guest-invite", TOKEN);
    helper.clearParticipantDevice(true);
    expect(tab.getItem("eventflow.guest-invite")).toBeNull();
  });
  it("malformed marker remains detectable as temporary presence and is safely cleared", () => {
    local.setItem(helper.PARTICIPANT_MARKER_KEY, "{bad-json");
    local.setItem("eventflow.guest-invite", TOKEN);
    expect(helper.getRememberedParticipant()).toBeNull();
    expect(helper.hasParticipantDeviceMarker()).toBe(true);
    helper.clearParticipantDevice();
    expect(local.getItem(helper.PARTICIPANT_MARKER_KEY)).toBeNull();
    expect(local.getItem("eventflow.guest-invite")).toBeNull();
  });
  it("storage-write restrictions still allow a current-tab memory-only marker", () => {
    local.setItem.mockImplementation(() => {
      throw new Error("blocked");
    });
    helper.rememberParticipant(session);
    helper.rememberParticipantInvite(TOKEN, session);
    expect(helper.getRememberedParticipant()?.id).toBe(session.id);
    expect(helper.participantInvitePath(session)).toBe(
      `/guest#invite=${TOKEN}`
    );
    helper.clearParticipantDevice();
    expect(helper.getRememberedParticipant()).toBeNull();
  });
  it("remote identity replacement clears only old tab material, not the new identity's stored invite", () => {
    const next = { ...session, id: "38f582ad-9fe0-4214-a6b7-8af42c5af39b" };
    helper.rememberParticipant(next);
    helper.rememberParticipantInvite(OTHER_TOKEN, next);
    local.setItem("eventflow.guest-invite", OTHER_TOKEN);
    tab.setItem("eventflow.guest-invite", TOKEN);
    pageUrl = new URL(`${ORIGIN}/guest#invite=${TOKEN}`);
    helper.clearParticipantTab();
    expect(helper.getRememberedParticipant()?.id).toBe(next.id);
    expect(helper.participantInvitePath(next)).toBe(
      `/guest#invite=${OTHER_TOKEN}`
    );
    expect(local.getItem("eventflow.guest-invite")).toBe(OTHER_TOKEN);
    expect(tab.getItem("eventflow.guest-invite")).toBeNull();
    expect(pageUrl.hash).toBe("");
  });
});

describe("server-calibrated monotonic clock", () => {
  it("ignores initial device clock skew and cannot extend when wall clock moves backward", () => {
    let perf = 200;
    let wall = START - 86400000;
    const clock = helper.createParticipantClock(
      session.issuedAt,
      () => perf,
      () => wall
    );
    expect(clock.offset).toBe(86400000);
    expect(clock.remaining(session)).toBe(TTL);
    perf += 10000;
    wall -= 86400000;
    expect(clock.remaining(session)).toBe(TTL - 10000);
    perf += 10000;
    expect(clock.remaining(session)).toBe(TTL - 20000);
    expect(clock.now()).toBe(START + 20000);
  });
  it("covers suspended performance timers with server offset wall time", () => {
    let wall = START;
    const clock = helper.createParticipantClock(
      session.issuedAt,
      () => 0,
      () => wall
    );
    wall += TTL;
    expect(clock.remaining(session)).toBe(0);
    wall -= 1000;
    expect(clock.remaining(session)).toBe(0);
  });
  it("does not roll deadline when recalibrated near its original expiry", () => {
    const clock = helper.createParticipantClock(
      new Date(START + TTL - 1000).toISOString(),
      () => 0,
      () => START + TTL - 1000
    );
    expect(clock.remaining(session)).toBe(1000);
    expect(session.expiresAt).toBe(new Date(START + TTL).toISOString());
  });
  it("a delayed GET response cannot move the current session's calibrated clock backward", async () => {
    respond(validStatus());
    await helper.startParticipantSession();
    monotonic = 10000;
    vi.setSystemTime(START + 10000);
    expect(helper.participantNow()).toBe(START + 10000);
    respond(validStatus(new Date(START + 5000).toISOString()));
    await helper.getParticipantStatus();
    expect(helper.participantNow()).toBe(START + 10000);
    expect(Date.parse(session.expiresAt) - helper.participantNow()).toBe(
      TTL - 10000
    );
  });
});

describe("strict same-origin participant link allowlist", () => {
  it.each([
    "/register/event-2026",
    `${ORIGIN}/register/event-2026`,
    "/register/abc_123",
    `/guest#invite=${TOKEN}`,
    `${ORIGIN}/guest#invite=${TOKEN}`,
  ])("accepts only local public participant link %s", link => {
    const result = helper.participantLinkPath(link, ORIGIN);
    expect(result).toMatch(/^\/(register\/|guest#invite=)/);
    expect(result).not.toContain("?");
    expect(result).not.toContain("://");
  });
  it.each([
    "https://outside.example.invalid/register/event",
    `https://outside.example.invalid/guest#invite=${TOKEN}`,
    "//eventflow.example.invalid/register/event",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///register/event",
    "/admin",
    "/workspace",
    "/join#invite=staff",
    "/participant",
    "/stage",
    "/api/auth/participant/start",
    "/register/event?returnTo=/admin",
    "/register/event?",
    "/register/event#",
    "/register/event#invite=token",
    `/guest?invite=${TOKEN}`,
    `/guest#invite=${TOKEN}&claim=${OTHER_TOKEN}`,
    `/guest#claim=${TOKEN}`,
    "/guest#invite=short",
    `/guest#invite=${TOKEN}&returnTo=/admin`,
    `/guest#invite=${TOKEN}%0a`,
    "/register/../register/event",
    "/register/%2e%2e/register/event",
    "/register/%2Fevent",
    "/register/event/",
    "/register/",
    "/register/a/b",
    "/\\outside.example.invalid/register/event",
    "https://user:pass@eventflow.example.invalid/register/event",
    "https://eventflow.example.invalid:444/register/event",
    "http://eventflow.example.invalid/register/event",
    "https://eventflow.example.invalid.evil.invalid/register/event",
    TOKEN,
    `#invite=${TOKEN}`,
    "register/event",
    "/register/a\nb",
    "/register/活動",
  ])("rejects external, staff, malformed or token-query link %s", link => {
    expect(() => helper.participantLinkPath(link, ORIGIN)).toThrow();
  });
});
