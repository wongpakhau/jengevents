export const demoEvent = {
  name: "示例活動",
  subtitle: "SAMPLE EVENT",
  date: "",
  time: "",
  venue: "待設定",
  guests: 0,
  checkedIn: 0,
  capacity: 0,
  sales: 0,
  chances: 0,
  merchants: 0,
};
export const demoTables = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  label: `示例桌 ${String(i + 1).padStart(2, "0")}`,
  count: 0,
  arrived: 0,
}));
export const demoGuests: Array<{
  name: string;
  en: string;
  table: string;
  type: string;
  arrived: boolean;
}> = [];
export const demoTransactions: Array<{
  id: string;
  merchant: string;
  category: string;
  initials: string;
  amount: number;
  chances: number;
  time: string;
  claimed: boolean;
}> = [];
export const money = (amount: number) =>
  new Intl.NumberFormat("en-HK", { maximumFractionDigits: 0 }).format(amount);
