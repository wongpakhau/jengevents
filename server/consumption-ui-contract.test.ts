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
