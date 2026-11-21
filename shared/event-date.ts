/** A calendar date without a time or timezone, kept separate from an instant. */
export function isEventCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

/** Preserve date-only values; normalize explicit ISO date-times as instants. */
export function normalizeEventDate(value: string): string | null {
  if (isEventCalendarDate(value)) return value;
  const datetime =
    /^(\d{4}-\d{2}-\d{2})[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/.exec(
      value
    );
  if (!datetime || !isEventCalendarDate(datetime[1])) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
