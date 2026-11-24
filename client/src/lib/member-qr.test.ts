import { describe, expect, it } from "vitest";
import { memberCodeFromQr, memberQrValue } from "./member-qr";

const origin = "https://bp.jengevents.com";

describe("member QR", () => {
  it("round-trips the merchant URL", () => {
    const value = memberQrValue("BP54", origin);
    expect(value).toBe("https://bp.jengevents.com/merchant#member=BP54");
    expect(memberCodeFromQr(value, origin)).toBe("BP54");
  });

  it("accepts a plainly typed code and normalises case", () => {
    expect(memberCodeFromQr(" bp54 ", origin)).toBe("BP54");
    expect(memberCodeFromQr("m123456", origin)).toBe("M123456");
  });

  it("rejects invitations, purchase codes and foreign origins", () => {
    expect(memberCodeFromQr(`${origin}/guest#invite=abc`, origin)).toBeNull();
    expect(
      memberCodeFromQr(`${origin}/merchant#purchase=xyz`, origin)
    ).toBeNull();
    expect(
      memberCodeFromQr(`${origin}/merchant#member=BP54&invite=abc`, origin)
    ).toBeNull();
    expect(
      memberCodeFromQr("https://evil.example/merchant#member=BP54", origin)
    ).toBeNull();
    expect(memberCodeFromQr("not a code!", origin)).toBeNull();
    expect(memberCodeFromQr("", origin)).toBeNull();
  });
});
