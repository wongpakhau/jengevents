import { describe, expect, it } from "vitest";
import { purchaseCodeFromQr } from "./purchase-qr";
const origin = "https://bp.jengevents.com";
describe("merchant consumption QR parsing", () => {
  it("reads only the server-returned consumption path", () => {
    expect(
      purchaseCodeFromQr(`${origin}/merchant#purchase=purpose-code`, origin)
    ).toBe("purpose-code");
    expect(purchaseCodeFromQr("/merchant#purchase=purpose-code", origin)).toBe(
      "purpose-code"
    );
  });
  it.each([
    `${origin}/guest#invite=guest-login`,
    `${origin}/guest#claim=receipt`,
    `${origin}/merchant#invite=guest-login`,
    `${origin}/merchant#purchase=one&invite=guest-login`,
    `${origin}/merchant#purchase=one&claim=receipt`,
    `${origin}/merchant#purchase=one&purchase=two`,
    "https://external.test/merchant#purchase=stolen",
    "https://user:pass@bp.jengevents.com/merchant#purchase=code",
    "guest-login",
    "/merchant#purchase=",
    "/merchants#purchase=code",
    "javascript:alert(1)",
  ])("rejects untrusted or wrong-purpose input %s", raw => {
    expect(purchaseCodeFromQr(raw, origin)).toBeNull();
  });
});
