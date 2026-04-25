import type { LoadRecord } from "../render/load.js";
import { pmcPointToRecord } from "../render/load.js";
import type { TPPerformanceDataPoint } from "../api/types.js";
import { isoWeekBounds } from "../util/isoWeek.js";

export interface WeekLoad {
  ctl_end: number | null; // CTL on last day of the week
  atl_end: number | null;
  tsb_end: number | null;
  weekly_tss: number; // sum of daily tss_actual (falls back to tss_planned for future days with no actual)
  ramp_rate: number | null; // ΔCTL_end vs prior week
  monotony: number | null; // mean / stdev of daily TSS (0 stdev → null)
  strain: number | null; // monotony * weekly_tss
}

/**
 * Build an indexed view of daily load records keyed by YYYY-MM-DD.
 */
export function indexLoad(points: TPPerformanceDataPoint[]): Map<string, LoadRecord> {
  const map = new Map<string, LoadRecord>();
  for (const p of points) {
    const r = pmcPointToRecord(p);
    if (r.date) map.set(r.date, r);
  }
  return map;
}

function daysInIsoWeek(isoYear: number, isoWeek: number, timezone: string): string[] {
  const { days } = isoWeekBounds(isoYear, isoWeek, timezone);
  return days.map((d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sqsum = values.reduce((a, b) => a + (b - mean) ** 2, 0);
  return Math.sqrt(sqsum / values.length);
}

/** Compute week-level load from the daily load index. */
export function computeWeekLoad(
  isoYear: number,
  isoWeek: number,
  timezone: string,
  loadIndex: Map<string, LoadRecord>,
): WeekLoad {
  const days = daysInIsoWeek(isoYear, isoWeek, timezone);
  const rows = days.map((d) => loadIndex.get(d)).filter(Boolean) as LoadRecord[];

  const last = rows[rows.length - 1];
  const ctl_end = last?.ctl ?? null;
  const atl_end = last?.atl ?? null;
  const tsb_end = last?.tsb ?? null;

  // Daily TSS: prefer actual, fall back to planned (for future weeks).
  const tssDaily = days.map((d) => {
    const r = loadIndex.get(d);
    if (!r) return 0;
    return r.tss_actual ?? r.tss_planned ?? 0;
  });
  const weekly_tss = Math.round(tssDaily.reduce((a, b) => a + b, 0));

  const mean = tssDaily.reduce((a, b) => a + b, 0) / (tssDaily.length || 1);
  const sd = stdev(tssDaily);
  const monotony = sd > 0 ? mean / sd : null;
  const strain = monotony !== null ? Math.round(monotony * weekly_tss) : null;

  // Ramp rate = CTL_end(this week) - CTL_end(prior week).
  let ramp_rate: number | null = null;
  if (ctl_end !== null) {
    const prior = priorWeek(isoYear, isoWeek);
    const priorDays = daysInIsoWeek(prior.isoYear, prior.isoWeek, timezone);
    const priorLast = loadIndex.get(priorDays[priorDays.length - 1]);
    if (priorLast?.ctl !== null && priorLast?.ctl !== undefined) {
      ramp_rate = Math.round((ctl_end - priorLast.ctl) * 10) / 10;
    }
  }

  return {
    ctl_end,
    atl_end,
    tsb_end,
    weekly_tss,
    ramp_rate,
    monotony: monotony !== null ? Math.round(monotony * 100) / 100 : null,
    strain,
  };
}

function priorWeek(isoYear: number, isoWeek: number): { isoYear: number; isoWeek: number } {
  if (isoWeek > 1) return { isoYear, isoWeek: isoWeek - 1 };
  // Previous year's last ISO week is 52 or 53.
  const prior = isoYear - 1;
  const jan1 = new Date(Date.UTC(prior, 0, 1)).getUTCDay();
  const dec31 = new Date(Date.UTC(prior, 11, 31)).getUTCDay();
  const weeks = jan1 === 4 || dec31 === 4 ? 53 : 52;
  return { isoYear: prior, isoWeek: weeks };
}
