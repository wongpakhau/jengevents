import { describe, it, expect } from "vitest";
import {
  isSystemOwner,
  roleCanManageMembers,
  GUEST_MANAGERS,
} from "./eventflow/access-policy";
describe("system access policy", () => {
  it.each([
    "pakhauwong@gmail.com",
    "mikilee1028@gmail.com",
    "yeeayeeahk@gmail.com",
    "garyyang020730@gmail.com",
  ])(
    "recognises only verified Google owner %s",
    email => {
      expect(
        isSystemOwner({ email, authProvider: "google", emailVerified: true })
      ).toBe(true);
      expect(
        isSystemOwner({ email, authProvider: "manus", emailVerified: true })
      ).toBe(false);
      expect(
        isSystemOwner({ email, authProvider: "google", emailVerified: false })
      ).toBe(false);
      expect(
        isSystemOwner({
          email: `  ${email.toUpperCase()}  `,
          authProvider: "google",
          emailVerified: true,
        })
      ).toBe(true);
      expect(
        isSystemOwner({
          email,
          authProvider: undefined,
          emailVerified: undefined,
        })
      ).toBe(false);
    }
  );
  it("refuses another registered or similar email", () => {
    expect(
      isSystemOwner({
        email: "someone@gmail.com",
        authProvider: "google",
        emailVerified: true,
      })
    ).toBe(false);
    expect(
      isSystemOwner({
        email: "pakhauwong@gmail.com.evil",
        authProvider: "google",
        emailVerified: true,
      })
    ).toBe(false);
  });
  it("project managers and guest managers cannot grant roles", () => {
    expect(roleCanManageMembers("project_manager")).toBe(false);
    expect(roleCanManageMembers("guest_manager")).toBe(false);
    expect(roleCanManageMembers("merchant")).toBe(false);
    expect(roleCanManageMembers("admin")).toBe(true);
    expect(GUEST_MANAGERS).toContain("guest_manager");
    expect(GUEST_MANAGERS).not.toContain("merchant");
  });
});
