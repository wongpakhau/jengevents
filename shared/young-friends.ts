export const ELITE_GUEST_EVENT_SLUG = "event-2c43e941";
export const ELITE_MALL_URL = "https://www.yeeahk.com/login";
export const ELITE_PHOTOS_URL = "https://app.pictogo.io/event/7A6037";
export const YOUNG_FRIENDS_WHATSAPP = "85261127981";
export const YOUNG_FRIENDS_TITLE = "申請香港島青年聯會之友（青聯之友）";

// Supplied by the organiser. Do not silently substitute legal/privacy terms.
export const PERSONAL_DECLARATIONS = [
  "申請者須遵守(香港島青年聯會章程,申請為會員,並待審核批准。",
  "申請者如有查詢或更改資料,須及時通知本會秘書處。",
  "申請者須完整填寫本申請表之資料,並由本會合資格之會員擔任入會介紹人,經本會批准成為正是會員。",
  "未屆滿18歲者須其家長或監護人同意,成為學生會員。",
  "所有收集之個人資料只供香港香港島青年聯會使用。",
] as const;
export const ASSOCIATION_DECLARATIONS = [
  "本會一向嚴格遵守《個人資料(私隱)條例》中各項規定,妥善儲存會員的個人資料,並確保資料準確無誤。",
  "為確保您能掌握本會的最新動向,我們將繼續為您提供舉辦之活動、課程、嘉許計劃、專業服務、意見收集、時事調查,募捐活動或其他與會務有關之活動等資訊。",
  "我們會根據您的個人資料,包括姓名、電話、電郵地址、通訊地址等,不時向閣下發放相關資訊。",
  "閣下的個人資料可能在有需要時提供予本會相關人員及部門,用作行政、傳訊及其他相關用途。未經同意,本會不會將您的個人資料轉予任何外界單位。",
  "倘若希望停止接收我們以上或某類別的資訊,請電郵 Info.hkiyou@gmail.com(註明:《個人資料(私隱)條例》)電郵通知本會秘書處,並列明您的中文姓名、身份證號碼、聯絡電話及電郵,以便跟進。",
] as const;
export const INFORMATION_CONSENT =
  "本人明白個人資料私隱專員公署《個人資料(私隱)條例》的相關條文,並願意提供個人 資料於香港島青年聯會並接收其相關資訊。";

export type YoungFriendsApplication = {
  chineseName: string;
  englishName: string;
  gender: "" | "男" | "女" | "其他";
  birthDate: string;
  email: string;
  mobile: string;
  address: string;
  declarationsAccepted: boolean;
  volunteer: "" | "同意" | "不同意";
  guardianConsent: boolean;
};
export type ApplicationErrors = Partial<
  Record<keyof YoungFriendsApplication, string>
>;
export const emptyYoungFriendsApplication = (): YoungFriendsApplication => ({
  chineseName: "",
  englishName: "",
  gender: "",
  birthDate: "",
  email: "",
  mobile: "",
  address: "",
  declarationsAccepted: false,
  volunteer: "",
  guardianConsent: false,
});

export function hongKongToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find(p => p.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function isUnder18(birthDate: string, today = hongKongToday()): boolean {
  if (!validDate(birthDate) || !validDate(today)) return false;
  let age = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  if (today.slice(5) < birthDate.slice(5)) age -= 1;
  return age < 18;
}
function safeLine(value: string): string {
  return value
    .trim()
    .replace(/[\r\n\t\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}
export function validateYoungFriendsApplication(
  form: YoungFriendsApplication,
  today = hongKongToday()
): ApplicationErrors {
  const errors: ApplicationErrors = {};
  if (!safeLine(form.chineseName) || form.chineseName.length > 80)
    errors.chineseName = "請填寫中文名字（最多80字）。";
  if (!safeLine(form.englishName) || form.englishName.length > 120)
    errors.englishName = "請填寫英文名字（最多120字）。";
  if (!["男", "女", "其他"].includes(form.gender))
    errors.gender = "請選擇性別。";
  if (
    !validDate(form.birthDate) ||
    form.birthDate < "1900-01-01" ||
    form.birthDate > today
  )
    errors.birthDate = "請填寫有效出生日期，不能是未來日期。";
  if (
    form.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())
  )
    errors.email = "請填寫有效電郵。";
  const phone = form.mobile.trim().replace(/[\s()-]/g, "");
  if (
    !/^(?:[456789]\d{7}|\+852[456789]\d{7}|852[456789]\d{7}|\+[1-9]\d{7,14})$/.test(
      phone
    )
  )
    errors.mobile = "請填寫8位香港手提電話，海外號碼請加國際區號。";
  if (!safeLine(form.address) || form.address.length > 500)
    errors.address =
      "請填寫完整住宅地址，包括樓層、單位及門牌號（最多500字）。";
  if (!form.declarationsAccepted)
    errors.declarationsAccepted =
      "請閱讀並同意個人聲明、本會聲明及資料使用說明。";
  if (!["同意", "不同意"].includes(form.volunteer))
    errors.volunteer = "請選擇是否同時登記成為青聯之友義工。";
  if (
    !errors.birthDate &&
    isUnder18(form.birthDate, today) &&
    !form.guardianConsent
  )
    errors.guardianConsent = "未滿18歲，請先取得家長或監護人同意。";
  return errors;
}
export function youngFriendsMessage(
  form: YoungFriendsApplication,
  today = hongKongToday()
): string {
  if (Object.keys(validateYoungFriendsApplication(form, today)).length)
    throw new Error("請先完成申請資料及聲明同意。");
  return [
    "Mc Jan，你好：",
    YOUNG_FRIENDS_TITLE,
    "",
    `中文名字：${safeLine(form.chineseName)}`,
    `英文名字：${safeLine(form.englishName)}`,
    `性別：${form.gender}`,
    `出生日期：${form.birthDate}`,
    `電郵：${safeLine(form.email)}`,
    `手提電話：${safeLine(form.mobile)}`,
    `住宅地址：${safeLine(form.address)}`,
    "",
    "聲明確認：清楚且同意申請頁的個人聲明及本會聲明。",
    `同時登記成為「青聯之友」義工：${form.volunteer}`,
    ...(isUnder18(form.birthDate, today)
      ? ["未滿18歲：已取得家長或監護人同意。"]
      : []),
    "本人明白個人資料私隱的相關條文，願意提供個人資料予香港島青年聯會並接收其相關資訊。",
    "",
    "以上為本人提交的申請資料，會員資格仍待本會審核批准。",
  ].join("\n");
}
export function youngFriendsWhatsAppUrl(
  form: YoungFriendsApplication,
  today = hongKongToday()
): string {
  return `https://wa.me/${YOUNG_FRIENDS_WHATSAPP}?text=${encodeURIComponent(youngFriendsMessage(form, today))}`;
}
