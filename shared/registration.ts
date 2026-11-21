export const CLASS_TYPES = ["BP", "格局", "金魂", "CBL"] as const;
export type ClassType = (typeof CLASS_TYPES)[number];

export function parseClass(
  type: unknown,
  value: unknown,
  required = true
): {
  classType: ClassType | "";
  classNumber: string;
} {
  if (!required && !type && !value) return { classType: "", classNumber: "" };
  if (typeof type !== "string" || !CLASS_TYPES.includes(type as ClassType)) {
    throw new Error("請選擇班種：BP、格局、金魂或CBL。");
  }
  if (typeof value !== "string") throw new Error("請自行輸入班號。");
  let number = value.normalize("NFKC").trim();
  if (number.toUpperCase().startsWith(type.toUpperCase()))
    number = number.slice(type.length).trim();
  if (!/^\d{1,4}$/.test(number) || Number(number) < 1) {
    throw new Error(`請輸入1至9999的班號，例如 ${type}62 或 62。`);
  }
  return { classType: type as ClassType, classNumber: String(Number(number)) };
}

/** Canonicalise HK local numbers and international numbers without guessing other countries. */
export function phoneIdentity(value: string): string {
  const compact = value.replace(/[\s()\-]/g, "");
  if (/^00[1-9]\d{6,14}$/.test(compact)) return `+${compact.slice(2)}`;
  if (/^[2-9]\d{7}$/.test(compact)) return `+852${compact}`;
  if (/^852[2-9]\d{7}$/.test(compact)) return `+${compact}`;
  return compact;
}

export function registrationPhone(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("請輸入電話號碼。");
  const phone = phoneIdentity(value.normalize("NFKC").trim());
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new Error(
      "請輸入8位香港電話，或含國際區號的電話，例如 +85291234567。"
    );
  }
  return phone;
}

export function classLabel(guest: {
  classType?: string;
  classNumber?: string;
}): string {
  return guest.classType && guest.classNumber
    ? `${guest.classType}${guest.classNumber}`
    : "";
}
