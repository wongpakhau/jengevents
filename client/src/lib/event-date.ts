import { isEventCalendarDate, normalizeEventDate } from "@shared/event-date";

export type EventDateFields = { date: string; time: string };

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** Canonical form used by the time input, including any nonzero seconds or milliseconds. */
function canonicalTime(value: string): string | null {
  const time = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (
    !time ||
    Number(time[1]) > 23 ||
    Number(time[2]) > 59 ||
    Number(time[3] || 0) > 59
  )
    return null;
  const milliseconds = Number((time[4] || "").padEnd(3, "0"));
  const seconds = Number(time[3] || 0);
  return `${time[1]}:${time[2]}${seconds || milliseconds ? `:${pad(seconds)}${milliseconds ? `.${pad(milliseconds, 3)}` : ""}` : ""}`;
}

/** A legacy wall-clock value has no known offset; never interpret it as an instant. */
function legacyDateTimeFields(value: string): EventDateFields | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(value);
  if (!match || !isEventCalendarDate(match[1])) return null;
  // ISO 24:00 is midnight at the start of the next calendar date. Do calendar
  // arithmetic in UTC only, without attaching an offset to the stored value.
  if (/^24:00(?::00(?:\.0+)?)?$/.test(match[2])) {
    const next = new Date(`${match[1]}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const date = next.toISOString().slice(0, 10);
    return isEventCalendarDate(date) ? { date, time: "00:00" } : null;
  }
  // Date and <input type="time"> support milliseconds, so match the precision
  // previously shown by the form while preserving the original on untouched saves.
  const time = canonicalTime(match[2].replace(/\.(\d{3})\d+$/, ".$1"));
  return time === null ? null : { date: match[1], time };
}

export function isLegacyEventDateTime(value: string): boolean {
  return legacyDateTimeFields(value) !== null;
}

/** Date-only and legacy wall-clock values are never interpreted in a timezone. */
export function eventDateFields(value: string): EventDateFields {
  if (isEventCalendarDate(value)) return { date: value, time: "" };
  const legacy = legacyDateTimeFields(value);
  if (legacy) return legacy;
  if (!normalizeEventDate(value)) return { date: "", time: "" };
  const instant = new Date(value);
  const date = `${pad(instant.getFullYear(), 4)}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
  const seconds = instant.getSeconds();
  const milliseconds = instant.getMilliseconds();
  const time = `${pad(instant.getHours())}:${pad(instant.getMinutes())}${seconds || milliseconds ? `:${pad(seconds)}${milliseconds ? `.${pad(milliseconds, 3)}` : ""}` : ""}`;
  return { date, time };
}

/** Preserve untouched explicit instants, including seconds and DST ambiguity. */
export function eventDateFromFields(
  fields: EventDateFields,
  original?: string
): string | null {
  if (!isEventCalendarDate(fields.date)) return null;
  if (!fields.time) return fields.date;
  const expected = canonicalTime(fields.time);
  if (expected === null) return null;
  if (original && normalizeEventDate(original)) {
    const previous = eventDateFields(original);
    if (fields.date === previous.date && expected === previous.time)
      return original;
  }
  const instant = new Date(`${fields.date}T${fields.time}`);
  if (Number.isNaN(instant.getTime())) return null;
  // A nonexistent local time (e.g. during a DST jump) must not silently shift.
  const roundTrip = eventDateFields(instant.toISOString());
  return roundTrip.date === fields.date && roundTrip.time === expected
    ? instant.toISOString()
    : null;
}

/** Omit an unchanged legacy value from settings PATCH rather than inventing its offset. */
export function eventDateUpdateFromFields(
  fields: EventDateFields,
  original: string,
  confirmLegacyTime = false
): { date?: string } | null {
  const legacy = legacyDateTimeFields(original);
  if (
    legacy &&
    !confirmLegacyTime &&
    fields.date === legacy.date &&
    canonicalTime(fields.time) === legacy.time
  )
    return {};
  const date = eventDateFromFields(fields, original);
  return date === null ? null : { date };
}

function browserOffset(instant: Date): string {
  const minutes = -instant.getTimezoneOffset();
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  return `GMT${minutes < 0 ? "-" : "+"}${hours}${remainder ? `:${pad(remainder)}` : ""}`;
}

export function formatEventDate(value: string | null | undefined): string {
  if (value && isEventCalendarDate(value)) return `${value} · 時間待定`;
  if (!value) return "日期待定 · 時間待定";
  const legacy = legacyDateTimeFields(value);
  if (legacy) return `${legacy.date} ${legacy.time} · 時區未指定`;
  if (!normalizeEventDate(value)) return "日期待定 · 時間待定";
  const instant = new Date(value);
  const display = new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
  return `${display}（瀏覽器當地時間 ${browserOffset(instant)}）`;
}

export function formatEventVenue(value: string | null | undefined): string {
  return value?.trim() || "場地待定";
}
