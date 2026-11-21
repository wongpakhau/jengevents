import type { Guest } from "./eventflow";
export const CHAPTERS = [
  "菁英會",
  "Noble",
  "Vitality Alliance",
  "Life",
] as const;
export type MemberKind = "core" | "member" | "guest" | "";
export type RosterIdentityInput = {
  name: string;
  chapter: string;
  invitedBy: string;
  classType?: string;
  classNumber?: string;
  phone: string;
};
export type RosterMatchView = {
  guestId: string;
  name: string;
  chapter: string;
  invitedBy: string;
  classType: string;
  classNumber: string;
  table: { number: number; label: string; seat: number | null } | null;
};
export function normalizedRosterText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase()
    : "";
}
export function chapterOf(
  guest: Pick<Guest, "group"> & { chapter?: string }
): string {
  if (guest.chapter?.trim()) return guest.chapter.trim();
  const group = guest.group || "";
  if (/noble/iu.test(group)) return "Noble";
  if (/vitality/iu.test(group)) return "Vitality Alliance";
  if (/life/iu.test(group)) return "Life";
  if (/菁英|核心/gu.test(group)) return "菁英會";
  return "";
}

export const NO_CHAPTER = "沒有所屬分會";
export const ROSTER_CANDIDATE_LIMIT = 8;
export type RosterSearchInput = {
  name: string;
  chapter?: string;
  invitedBy?: string;
  classType?: string;
  classNumber?: string;
};
export type RosterSearchView = {
  candidates: RosterMatchView[];
  requiresRefinement: boolean;
};
/** Consent-gated public fallback directory. This response intentionally contains names only. */
export type RosterNameDirectoryView = { names: string[] };
export type RosterSelectionInput = RosterSearchInput & { phone: string };
