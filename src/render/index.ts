import path from "node:path";
import type { LoadRecord } from "./load.js";
import type { AthleteProfile } from "../io/athlete.js";
import type { Event } from "../transform/workout.js";
import { writeAtomic } from "../io/fs.js";

export interface IndexContext {
  athleteId: number;
  timezone: string;
  generatedAt: Date;
  outDir: string;
  load: LoadRecord[];
  events: Event[];
  profile: AthleteProfile | null;
}

/**
 * Render a small dashboard: last 12 ISO weeks of CTL/TSB sparkline, current
 * CTL/ATL/TSB, A-race countdown, current block. Intended as an LLM "where am I"
 * anchor — keep it under ~2 KB.
 */
export async function writeIndex(ctx: IndexContext): Promise<string> {
  const p = path.join(ctx.outDir, "_generated", "index.md");
  const today = dateInTz(ctx.generatedAt, ctx.timezone);

  const recent = ctx.load.filter((r) => r.date <= today).slice(-84); // ~12 weeks
  const last = recent[recent.length - 1];

  const parts: string[] = [];
  parts.push("---");
  parts.push(`generated_at: ${ctx.generatedAt.toISOString()}`);
  parts.push(`athlete_id: ${ctx.athleteId}`);
  parts.push(`timezone: ${ctx.timezone}`);
  parts.push("---");
  parts.push("");
  parts.push("# Training dashboard");
  parts.push("");

  // Current state.
  if (last) {
    parts.push("## Current state");
    parts.push("");
    parts.push(`- **Date**: ${today}`);
    parts.push(`- **CTL**: ${fmtNum(last.ctl)}  (fitness)`);
    parts.push(`- **ATL**: ${fmtNum(last.atl)}  (fatigue)`);
    parts.push(`- **TSB**: ${fmtNum(last.tsb)}  (form — ${tsbBand(last.tsb)})`);
    parts.push("");
  }

  // Profile block: training block / phase only. Physiology is in `_generated/athlete.tp.md`.
  if (ctx.profile?.current_block) {
    parts.push("## Block");
    parts.push("");
    parts.push(
      `- **Block**: ${ctx.profile.current_block}` +
        (ctx.profile.phase_start ? ` (since ${ctx.profile.phase_start})` : ""),
    );
    parts.push("");
  }

  // Next A-race from profile goals + TP events.
  const upcoming = upcomingRaces(ctx, today);
  if (upcoming.length > 0) {
    parts.push("## Upcoming races");
    parts.push("");
    for (const u of upcoming.slice(0, 5)) {
      const days = diffDays(today, u.date);
      parts.push(
        `- **${u.date}** (T-${days}d) — ${u.name}${u.priority ? ` [${u.priority}]` : ""}`,
      );
    }
    parts.push("");
  }

  // CTL sparkline — last 12 weeks, one datapoint per week (end-of-week CTL).
  const sparkData = weeklyCtlSeries(recent);
  if (sparkData.length > 0) {
    parts.push("## CTL, last 12 weeks");
    parts.push("");
    parts.push("```");
    parts.push(sparkline(sparkData.map((d) => d.ctl)));
    parts.push(
      `min ${Math.min(...sparkData.map((d) => d.ctl)).toFixed(0)}  ` +
        `max ${Math.max(...sparkData.map((d) => d.ctl)).toFixed(0)}  ` +
        `now ${sparkData[sparkData.length - 1].ctl.toFixed(0)}`,
    );
    parts.push("```");
    parts.push("");
  }

  // TSB sparkline.
  const tsbSeries = recent.filter((r) => r.tsb !== null).map((r) => r.tsb as number);
  if (tsbSeries.length > 0) {
    parts.push("## TSB, last ~12 weeks");
    parts.push("");
    parts.push("```");
    parts.push(sparkline(tsbSeries));
    parts.push(
      `min ${Math.min(...tsbSeries).toFixed(0)}  max ${Math.max(...tsbSeries).toFixed(0)}  now ${tsbSeries[tsbSeries.length - 1].toFixed(0)}`,
    );
    parts.push("```");
    parts.push("");
  }

  const content = parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  await writeAtomic(p, content);
  return p;
}

function fmtNum(v: number | null): string {
  return v === null ? "—" : v.toFixed(1);
}

function tsbBand(tsb: number | null): string {
  if (tsb === null) return "?";
  if (tsb > 25) return "very fresh (detraining risk)";
  if (tsb > 10) return "fresh (race ready)";
  if (tsb > 0) return "neutral";
  if (tsb > -10) return "tired (absorbing)";
  if (tsb > -25) return "very tired";
  return "exhausted (overreach risk)";
}

function dateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function diffDays(fromYmd: string, toYmd: string): number {
  const a = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const b = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

function upcomingRaces(
  ctx: IndexContext,
  today: string,
): Array<{ date: string; name: string; priority?: string }> {
  const out: Array<{ date: string; name: string; priority?: string }> = [];
  for (const g of ctx.profile?.goals ?? []) {
    if (g.date && g.date >= today) out.push({ date: g.date, name: g.name, priority: g.priority });
  }
  for (const e of ctx.events) {
    if (e.date >= today) {
      out.push({ date: e.date, name: e.title, priority: e.priority });
    }
  }
  // Sort ascending.
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function weeklyCtlSeries(
  records: LoadRecord[],
): Array<{ date: string; ctl: number }> {
  // Group by ISO week using the date string and take last day per week.
  // Cheap grouping without timezone math — good enough for visual.
  const byWeek = new Map<string, { date: string; ctl: number }>();
  for (const r of records) {
    if (r.ctl === null) continue;
    const week = isoWeekKey(r.date);
    const prev = byWeek.get(week);
    if (!prev || r.date > prev.date) byWeek.set(week, { date: r.date, ctl: r.ctl });
  }
  return [...byWeek.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function isoWeekKey(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  // Thursday in current week determines the year.
  const thurs = new Date(d);
  thurs.setUTCDate(thurs.getUTCDate() - ((thurs.getUTCDay() + 6) % 7) + 3);
  const y = thurs.getUTCFullYear();
  const yStart = new Date(Date.UTC(y, 0, 1));
  const weekNo = Math.ceil(((thurs.getTime() - yStart.getTime()) / 86400000 + 1) / 7);
  return `${y}-W${String(weekNo).padStart(2, "0")}`;
}

/** ASCII sparkline using Unicode block characters. */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v) => {
      const idx = Math.min(chars.length - 1, Math.max(0, Math.round(((v - min) / range) * (chars.length - 1))));
      return chars[idx];
    })
    .join("");
}
