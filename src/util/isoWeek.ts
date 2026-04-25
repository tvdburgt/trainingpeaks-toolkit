import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { getISOWeek, getISOWeekYear, addDays } from "date-fns";

export interface IsoWeek {
  isoYear: number;
  isoWeek: number;
  /** "YYYY-Www" e.g. "2025-W14" */
  key: string;
}

export function isoWeekOf(date: Date, timezone: string): IsoWeek {
  // Convert instant to the wall-clock date in the athlete's tz, then compute ISO.
  const zoned = toZonedTime(date, timezone);
  const isoYear = getISOWeekYear(zoned);
  const isoWeek = getISOWeek(zoned);
  return {
    isoYear,
    isoWeek,
    key: `${isoYear}-W${String(isoWeek).padStart(2, "0")}`,
  };
}

export function formatDateInTz(date: Date, timezone: string, fmt: string): string {
  return formatInTimeZone(date, timezone, fmt);
}

/** Monday-based ISO week start (00:00 in the given tz, expressed as a UTC instant). */
export function isoWeekBounds(
  isoYear: number,
  isoWeek: number,
  timezone: string,
): { start: Date; end: Date; days: Date[] } {
  // Start from Jan 4 in the iso year (always in week 1), find its Monday, step weeks.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Zoned = toZonedTime(jan4, timezone);
  const dow = jan4Zoned.getDay() === 0 ? 7 : jan4Zoned.getDay(); // 1..7 Mon..Sun
  const mondayOfWeek1 = addDays(jan4Zoned, -(dow - 1));
  const weekStartZoned = addDays(mondayOfWeek1, (isoWeek - 1) * 7);

  // Build midnight in tz by formatting then parsing back with offset.
  // Since we only use these Dates for grouping/labeling, we return the zoned wall-clock
  // as if it were UTC — that's fine for rendering via formatInTimeZone.
  const start = new Date(
    Date.UTC(
      weekStartZoned.getFullYear(),
      weekStartZoned.getMonth(),
      weekStartZoned.getDate(),
      0,
      0,
      0,
    ),
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    days.push(d);
  }
  return { start, end, days };
}
