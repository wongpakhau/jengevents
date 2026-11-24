import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("consumption UI connection regressions", () => {
  it("does not auto-confirm a scanned legacy receipt", () => {
    const source = read("client/src/pages/GuestPortal.tsx");
    expect(source).not.toContain("autoClaimAttempt");
    expect(source).toContain('"/guest/claim-preview"');
    expect(source).toContain("確認金額並領取");
  });
  it("binds claim completion to the actual submitted QR and locks scanning during a claim", () => {
    const source = read("client/src/pages/GuestPortal.tsx");
    expect(source).toContain("const submittedClaim = pendingClaim");
    expect(source).toContain("pendingClaimScope.current === submittedClaim");
    expect(source).toContain("disabled={claiming || accessPending}");
  });
  it("reloads guest identity when retry cannot safely confirm a receipt", () => {
    const source = read("client/src/pages/GuestPortal.tsx");
    expect(source).toMatch(
      /pendingClaim\s*&&\s*inviteToken\s*&&\s*claimPreview\s*\?\s*void claimReceipt\(\)\s*:\s*void loadGuest\(\)/
    );
  });
  it("uses consumption QR, not the guest login invitation, on the ticket panel", () => {
    const source = read("client/src/components/event/ConsumerTickets.tsx");
    expect(source).toContain('"/guest/purchase-code"');
    expect(source).toContain("value={code.path}");
    expect(source).not.toContain("value={inviteToken}");
    expect(source).toContain("confirmed: boolean");
  });
  it("keeps the merchant scanner embedded so manual Enter cannot submit the outer receipt form", () => {
    const merchant = read("client/src/pages/MerchantTerminal.tsx");
    const scanner = read("client/src/components/event/QRScanner.tsx");
    expect(merchant).toMatch(/<QRScanner\s+embedded/);
    expect(scanner).toContain('embedded ? "div" : "form"');
    expect(scanner).toContain("event.stopPropagation()");
  });
  it("declares the three standalone demo roles and preserves real Google login", () => {
    const app = read("client/src/App.tsx");
    const gate = read("client/src/components/event/WorkspaceGate.tsx");
    for (const [role, label] of [
      ["admin", "測試管理員"],
      ["merchant", "商家測試"],
      ["guest", "用家測試"],
    ]) {
      expect(app).toContain(`/demo/${role}`);
      expect(gate).toContain(label);
    }
    expect(gate).toContain("startLogin(returnTo)");
    const demo =
      read("client/src/pages/RoleDemo.tsx") +
      read("client/src/lib/role-demo.ts");
    expect(demo).not.toMatch(
      /eventflow-api|document\.cookie|apiGuest\(|apiFetch\(/
    );
  });
});

describe("role entry and landing regressions", () => {
  it("offers the three real roles on the login page and forwards each to its workspace", () => {
    const gate = read("client/src/components/event/WorkspaceGate.tsx");
    expect(gate).toContain("RoleEntry");
    expect(gate).toContain("RoleLanding");
    expect(gate).toContain("shouldForwardFromRoot(");
    expect(gate).toContain('returnTo="/merchant"');
    for (const label of ["大會管理員／工作人員", "商家", "用戶／嘉賓"]) {
      expect(gate).toContain(label);
    }
  });
  it("keeps the Google returnTo allowlist in step with the role landing paths", () => {
    const auth = read("server/_core/googleAuth.ts");
    const roleHome = read("client/src/lib/role-home.ts");
    for (const path of [
      "/merchant",
      "/checkin",
      "/draw",
      "/guests",
      "/settlements",
    ]) {
      expect(auth).toContain(`"${path}"`);
      expect(roleHome).toContain(`"${path}"`);
    }
    expect(auth).not.toContain('"/screen"');
  });
  it("gives merchants a scan-first three-step terminal and a navigation entry", () => {
    const merchant = read("client/src/pages/MerchantTerminal.tsx");
    const shell = read("client/src/components/event/EventShell.tsx");
    expect(merchant).toContain("MerchantSteps");
    expect(merchant).toContain("useState(true)");
    expect(merchant).toContain("autoReference()");
    expect(shell).toContain('path: "/merchant"');
  });
  it("shows the guest's own consumption QR first without an extra tap", () => {
    const portal = read("client/src/pages/GuestPortal.tsx");
    const tickets = read("client/src/components/event/ConsumerTickets.tsx");
    expect(portal).toMatch(/<ConsumerTickets[\s\S]*?autoShow[\s\S]*?\/>/);
    expect(tickets).toContain("autoShown.current = true");
    expect(portal.indexOf("<ConsumerTickets")).toBeLessThan(
      portal.indexOf('className="guest-stat-grid"')
    );
  });
  it("renders overview quick actions without wouter location in non-browser renders", () => {
    const overview = read("client/src/components/event/AdminOverview.tsx");
    expect(overview).toContain('typeof window === "undefined"');
    expect(overview).toContain('className="mvp-quick-actions"');
    expect(overview).toContain("session?.canManageAccess");
  });
});
