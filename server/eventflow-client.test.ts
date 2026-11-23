import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  apiGuest,
  apiFetch,
  ApiError,
  money,
} from "../client/src/lib/eventflow-api";
import { COOKIE_NAME } from "../shared/const";
afterEach(() => vi.unstubAllGlobals());
describe("eventflow API transport", () => {
  it("forwards supplied Preview session without manufacturing identity", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => `another=x; ${COOKIE_NAME}=valid-test-session`,
    });
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetch);
    await api(
      "/events/e/receipts",
      "POST",
      { amountCents: 100000 },
      "same-key"
    );
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/eventflow/events/e/receipts");
    expect(init.credentials).toBe("include");
    expect(init.headers.Authorization).toBe("Bearer valid-test-session");
    expect(init.headers["Idempotency-Key"]).toBe("same-key");
  });
  it("never sends a forged staff identity for guests", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => `${COOKIE_NAME}=staff-session`,
    });
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ gained: 2 })));
    vi.stubGlobal("fetch", fetch);
    await apiGuest(
      "/guest/claim",
      "guest-capability",
      "POST",
      { token: "receipt-capability" },
      "claim-key"
    );
    const init = fetch.mock.calls[0][1];
    expect(init.headers["X-Guest-Token"]).toBe("guest-capability");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ token: "receipt-capability" });
  });
  it("sends an explicit customer decision without any staff identity", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => `${COOKIE_NAME}=staff-session`,
    });
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ total: 1 })));
    vi.stubGlobal("fetch", fetch);
    await apiGuest(
      "/guest/receipts/receipt-id/decision",
      "own-guest",
      "POST",
      { confirmed: true },
      "decision-once"
    );
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/eventflow/guest/receipts/receipt-id/decision");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["X-Guest-Token"]).toBe("own-guest");
    expect(init.headers["Idempotency-Key"]).toBe("decision-once");
    expect(JSON.parse(init.body)).toEqual({ confirmed: true });
  });
  it("refreshes the customer's own spending without browser cache", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ receipts: [] })));
    vi.stubGlobal("fetch", fetch);
    await apiGuest("/guest", "own-guest");
    expect(fetch.mock.calls[0][1].cache).toBe("no-store");
  });
  it("keeps real unauthenticated state and exposes server conflict errors", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: "請先登入", code: "UNAUTHORIZED" }),
            { status: 401 }
          )
        )
    );
    await expect(api("/session")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });
  it("fails on SPA fallback HTML instead of returning fake data", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>fallback</html>"))
    );
    await expect(api("/session")).rejects.toBeInstanceOf(ApiError);
  });
  it("rejects absolute or protocol-relative API destinations", async () => {
    await expect(apiFetch("//external.test")).rejects.toThrow("API");
    await expect(apiGuest("https://external.test", "cap")).rejects.toThrow(
      "API"
    );
  });
  it("formats integer cents as HKD without changing stored amounts", () => {
    expect(money(230000)).toContain("2,300.00");
  });
});
