import { describe, expect, it } from "vitest";
import {
  emptyYoungFriendsApplication,
  hongKongToday,
  isUnder18,
  validateYoungFriendsApplication,
  youngFriendsMessage,
  youngFriendsWhatsAppUrl,
  ELITE_MALL_URL,
  ELITE_PHOTOS_URL,
  PERSONAL_DECLARATIONS,
  ASSOCIATION_DECLARATIONS,
  type YoungFriendsApplication,
} from "../shared/young-friends";
const TODAY = "2026-01-01";
const complete = (
  patch: Partial<YoungFriendsApplication> = {}
): YoungFriendsApplication => ({
  chineseName: "測試申請人",
  englishName: "Test Applicant",
  gender: "女",
  birthDate: "2000-05-06",
  email: "test@example.com",
  mobile: "91234567",
  address: "測試街1號1樓A室",
  declarationsAccepted: true,
  volunteer: "不同意",
  guardianConsent: false,
  ...patch,
});
describe("young friends client-only application", () => {
  it("requires all 7 data fields plus declarations and explicit volunteer selection", () => {
    expect(
      Object.keys(
        validateYoungFriendsApplication(emptyYoungFriendsApplication(), TODAY)
      )
    ).toHaveLength(9);
    expect(validateYoungFriendsApplication(complete(), TODAY)).toEqual({});
  });
  it("never treats declining volunteering as declining the application", () => {
    expect(
      validateYoungFriendsApplication(complete({ volunteer: "不同意" }), TODAY)
    ).toEqual({});
    expect(youngFriendsMessage(complete(), TODAY)).toContain("義工：不同意");
    expect(
      youngFriendsMessage(complete({ volunteer: "同意" }), TODAY)
    ).toContain("義工：同意");
  });
  it("does not generate a WhatsApp link without required consent or data", () => {
    expect(() =>
      youngFriendsWhatsAppUrl(complete({ declarationsAccepted: false }), TODAY)
    ).toThrow();
    expect(() =>
      youngFriendsWhatsAppUrl(complete({ volunteer: "" }), TODAY)
    ).toThrow();
    expect(() =>
      youngFriendsWhatsAppUrl(complete({ address: "" }), TODAY)
    ).toThrow();
  });
  it("rejects future dates, nonexistent dates and invalid email/mobile", () => {
    for (const birthDate of [
      "2027-01-01",
      "2001-02-29",
      "2000-13-01",
      "1899-01-01",
      "bad",
    ])
      expect(
        validateYoungFriendsApplication(complete({ birthDate }), TODAY)
          .birthDate
      ).toBeTruthy();
    expect(
      validateYoungFriendsApplication(complete({ email: "a@" }), TODAY).email
    ).toBeTruthy();
    expect(
      validateYoungFriendsApplication(complete({ mobile: "123" }), TODAY).mobile
    ).toBeTruthy();
    expect(
      validateYoungFriendsApplication(
        complete({ mobile: "+852 9123 4567" }),
        TODAY
      ).mobile
    ).toBeUndefined();
  });
  it("checks the exact eighteenth-birthday boundary and guardian consent", () => {
    expect(isUnder18("2008-01-01", TODAY)).toBe(false);
    expect(isUnder18("2008-01-02", TODAY)).toBe(true);
    expect(
      validateYoungFriendsApplication(
        complete({ birthDate: "2010-01-01" }),
        TODAY
      ).guardianConsent
    ).toBeTruthy();
    const minor = complete({ birthDate: "2010-01-01", guardianConsent: true });
    expect(validateYoungFriendsApplication(minor, TODAY)).toEqual({});
    expect(youngFriendsMessage(minor, TODAY)).toContain(
      "已取得家長或監護人同意"
    );
  });
  it("uses Hong Kong calendar day across the UTC date boundary", () => {
    expect(hongKongToday(new Date("2025-12-31T16:01:00Z"))).toBe(TODAY);
  });
  it("safely URL-encodes all message content to exactly the requested recipient", () => {
    const f = complete({ address: "測試街1號A室 & # + ?" });
    const url = new URL(youngFriendsWhatsAppUrl(f, TODAY));
    expect(url.origin).toBe("https://wa.me");
    expect(url.pathname).toBe("/85261127981");
    expect([...url.searchParams.keys()]).toEqual(["text"]);
    expect(url.hash).toBe("");
    expect(url.searchParams.get("text")).toBe(youngFriendsMessage(f, TODAY));
    expect(url.searchParams.get("text")).toContain(f.address);
  });
  it("prevents user-entered line breaks from forging declaration fields", () => {
    const message = youngFriendsMessage(
      complete({ chineseName: "測試\n聲明確認：假資料", address: "街\n1號" }),
      TODAY
    );
    expect(
      message.split("\n").filter(x => x.startsWith("聲明確認："))
    ).toHaveLength(1);
    expect(message).toContain("住宅地址：街 1號");
  });
  it("preserves supplied statements and exact external destinations", () => {
    expect(PERSONAL_DECLARATIONS).toHaveLength(5);
    expect(ASSOCIATION_DECLARATIONS).toHaveLength(5);
    expect(ASSOCIATION_DECLARATIONS.join("\n")).toContain(
      "Info.hkiyou@gmail.com"
    );
    expect(ELITE_MALL_URL).toBe("https://www.yeeahk.com/login");
    expect(ELITE_PHOTOS_URL).toBe("https://app.pictogo.io/event/7A6037");
  });
});
