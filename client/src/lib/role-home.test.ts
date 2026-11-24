import { describe, expect, it } from "vitest";
import {
  GUEST_INVITE_STORAGE_KEY,
  STAFF_RETURN_PATHS,
  guestEntryPath,
  roleHome,
  roleHomeLabel,
  shouldForwardFromRoot,
  staffReturnPath,
} from "./role-home";

const storage = (entries: Record<string, string> = {}) => ({
  getItem: (key: string) => entries[key] ?? null,
});

describe("roleHome", () => {
  it("sends each event role to its own first screen", () => {
    expect(roleHome("merchant")).toBe("/merchant");
    expect(roleHome("checkin")).toBe("/checkin");
    expect(roleHome("draw")).toBe("/draw");
    expect(roleHome("guest_manager")).toBe("/guests");
    for (const role of ["owner", "admin", "project_manager"] as const)
      expect(roleHome(role)).toBe("/");
    expect(roleHome(null)).toBe("/");
    expect(roleHome(undefined)).toBe("/");
  });
  it("keeps commerce roles on the overview for attendance-only ceremonies", () => {
    expect(roleHome("merchant", "attendance")).toBe("/");
    expect(roleHome("draw", "attendance")).toBe("/");
    expect(roleHome("checkin", "attendance")).toBe("/checkin");
    expect(roleHome("guest_manager", "attendance")).toBe("/guests");
  });
  it("only returns paths the server accepts for Google returnTo", () => {
    for (const role of [
      "owner",
      "admin",
      "project_manager",
      "guest_manager",
      "checkin",
      "draw",
      "merchant",
    ] as const) {
      expect(STAFF_RETURN_PATHS).toContain(roleHome(role));
      expect(STAFF_RETURN_PATHS).toContain(roleHome(role, "attendance"));
    }
  });
  it("labels the destination in plain language", () => {
    expect(roleHomeLabel("merchant")).toBe("商戶掃碼開單");
    expect(roleHomeLabel("checkin")).toBe("現場簽到台");
    expect(roleHomeLabel("draw")).toBe("抽獎控制");
    expect(roleHomeLabel("guest_manager")).toBe("嘉賓管理");
    expect(roleHomeLabel("admin")).toBe("活動總覽");
  });
});

describe("shouldForwardFromRoot", () => {
  it("forwards non-admin roles from the workspace root only", () => {
    expect(shouldForwardFromRoot("/", "merchant")).toBe(true);
    expect(shouldForwardFromRoot("/", "checkin")).toBe(true);
    expect(shouldForwardFromRoot("/", "admin")).toBe(false);
    expect(shouldForwardFromRoot("/settlements", "merchant")).toBe(false);
    expect(shouldForwardFromRoot("/guests", "guest_manager")).toBe(false);
    expect(shouldForwardFromRoot("/", "merchant", "attendance")).toBe(false);
  });
});

describe("staffReturnPath", () => {
  it("accepts only the fixed staff paths", () => {
    expect(staffReturnPath("/merchant")).toBe("/merchant");
    expect(staffReturnPath("/checkin")).toBe("/checkin");
    expect(staffReturnPath("/")).toBe("/");
    expect(staffReturnPath("/screen")).toBe("/");
    expect(staffReturnPath("/merchant#purchase=abc")).toBe("/");
    expect(staffReturnPath("//attacker.invalid")).toBe("/");
    expect(staffReturnPath("https://attacker.invalid/")).toBe("/");
  });
});

describe("guestEntryPath", () => {
  it("opens the guest page only when this device remembers an invitation", () => {
    expect(guestEntryPath(storage(), storage())).toBe("/participant");
    expect(guestEntryPath(null, null)).toBe("/participant");
    expect(
      guestEntryPath(storage({ [GUEST_INVITE_STORAGE_KEY]: "tok" }), storage())
    ).toBe("/guest");
    expect(
      guestEntryPath(storage(), storage({ [GUEST_INVITE_STORAGE_KEY]: "tok" }))
    ).toBe("/guest");
    expect(
      guestEntryPath(storage({ [GUEST_INVITE_STORAGE_KEY]: "" }), storage())
    ).toBe("/participant");
  });
  it("treats blocked storage as no remembered invitation", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(guestEntryPath(throwing, throwing)).toBe("/participant");
  });
});
