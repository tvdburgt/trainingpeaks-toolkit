import type { Workout, StructureStep, Lap, Comment } from "../transform/workout.js";
import type { WeekBucket } from "../transform/week.js";
import type { WeekLoad } from "../transform/load.js";
import { classifyIntent, intentMix } from "../transform/intent.js";
import { isoWeekBounds } from "../util/isoWeek.js";
import { formatInTimeZone } from "date-fns-tz";
import {
  fmtDuration,
  fmtLapDuration,
  fmtKm,
  fmtMeters,
  fmtInt,
  fmtFloat,
  fmtPaceFromMps,
  tcell,
} from "./format.js";

export interface RenderContext {
  athleteId: number;
  timezone: string;
  generatedAt: Date;
  load?: WeekLoad;
  phase?: "past" | "current" | "future";
}

export function renderWeek(bucket: WeekBucket, ctx: RenderContext): string {
  const { start, end } = isoWeekBounds(bucket.isoYear, bucket.isoWeek, ctx.timezone);
  const startLabel = formatInTimeZone(start, "UTC", "yyyy-MM-dd");
  const endLabel = formatInTimeZone(end, "UTC", "yyyy-MM-dd");
  const startHuman = formatInTimeZone(start, "UTC", "MMM d");
  const endHuman = formatInTimeZone(end, "UTC", "MMM d");

  const totals = computeTotals(bucket.workouts);
  const bySport = computeBySport(bucket.workouts);

  const parts: string[] = [];
  parts.push(renderFrontmatter(bucket, startLabel, endLabel, totals, bySport, ctx));
  parts.push("");
  parts.push(`# Week ${bucket.key} (${startHuman} – ${endHuman})`);
  parts.push("");

  const summary = renderWeekSummary(bucket, ctx);
  if (summary) {
    parts.push(summary);
    parts.push("");
  }

  const plannedAhead = renderPlannedAhead(bucket, ctx);
  if (plannedAhead) {
    parts.push(plannedAhead);
    parts.push("");
  }

  parts.push(renderTotalsTable(totals, bySport));
  parts.push("");

  if (bucket.workouts.length === 0) {
    parts.push("_No workouts this week._");
    parts.push("");
    return parts.join("\n");
  }

  // Group workouts by day.
  const byDay = new Map<string, Workout[]>();
  for (const w of bucket.workouts) {
    const arr = byDay.get(w.date) ?? [];
    arr.push(w);
    byDay.set(w.date, arr);
  }
  const sortedDays = [...byDay.keys()].sort();

  for (const day of sortedDays) {
    const workouts = byDay.get(day)!;
    const dayLabel = formatInTimeZone(new Date(`${day}T12:00:00Z`), "UTC", "EEEE yyyy-MM-dd");
    parts.push(`## ${dayLabel}`);
    parts.push("");
    for (const w of workouts) {
      parts.push(renderWorkout(w));
      parts.push("");
      parts.push("---");
      parts.push("");
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderFrontmatter(
  bucket: WeekBucket,
  startLabel: string,
  endLabel: string,
  totals: Totals,
  bySport: Map<string, Totals>,
  ctx: RenderContext,
): string {
  const sportLines: string[] = [];
  for (const [sport, t] of bySport) {
    sportLines.push(`  ${yamlKey(sport)}:`);
    sportLines.push(`    sessions: ${t.workouts}`);
    sportLines.push(`    duration_min: ${Math.round(t.durationSeconds / 60)}`);
    sportLines.push(`    distance_km: ${(t.distanceMeters / 1000).toFixed(1)}`);
    sportLines.push(`    tss: ${Math.round(t.tss)}`);
  }

  const loadLines: string[] = [];
  if (ctx.load) {
    loadLines.push("load:");
    loadLines.push(`  ctl_end: ${fmtYamlNumber(ctx.load.ctl_end)}`);
    loadLines.push(`  atl_end: ${fmtYamlNumber(ctx.load.atl_end)}`);
    loadLines.push(`  tsb_end: ${fmtYamlNumber(ctx.load.tsb_end)}`);
    loadLines.push(`  weekly_tss: ${ctx.load.weekly_tss}`);
    loadLines.push(`  ramp_rate: ${fmtYamlNumber(ctx.load.ramp_rate)}`);
    loadLines.push(`  monotony: ${fmtYamlNumber(ctx.load.monotony)}`);
    loadLines.push(`  strain: ${fmtYamlNumber(ctx.load.strain)}`);
  }

  // Intent mix — share of weekly TSS by intent, sorted desc.
  const mix = intentMix(bucket.workouts);
  const intentLines: string[] = [];
  if (mix.size > 0) {
    intentLines.push("intent_mix:");
    for (const [intent, share] of mix) {
      intentLines.push(`  ${intent}: ${share}`);
    }
  }

  // Adherence (past weeks only — meaningful for completed plans).
  const adherenceLines: string[] = [];
  if (ctx.phase === "past" && bucket.workouts.length > 0) {
    const planned = bucket.workouts.filter(
      (w) => w.planned.tss !== undefined || w.planned.durationSeconds !== undefined,
    );
    const completed = bucket.workouts.filter((w) => w.completed);
    const plannedTss = bucket.workouts.reduce((a, w) => a + (w.planned.tss ?? 0), 0);
    const actualTss = bucket.workouts.reduce((a, w) => a + (w.actual.tss ?? 0), 0);
    adherenceLines.push("adherence:");
    adherenceLines.push(`  sessions_completed: ${completed.length}`);
    adherenceLines.push(`  sessions_planned: ${planned.length}`);
    adherenceLines.push(
      `  tss_actual_vs_planned: ${plannedTss > 0 ? Math.round((actualTss / plannedTss) * 100) / 100 : "null"}`,
    );
  }

  const lines = [
    "---",
    `iso_year: ${bucket.isoYear}`,
    `iso_week: ${bucket.isoWeek}`,
    `date_range: ${startLabel} .. ${endLabel}`,
    `timezone: ${ctx.timezone}`,
    `athlete_id: ${ctx.athleteId}`,
    ...(ctx.phase ? [`phase: ${ctx.phase}`] : []),
    "totals:",
    `  sessions: ${totals.workouts}`,
    `  duration_min: ${Math.round(totals.durationSeconds / 60)}`,
    `  distance_km: ${(totals.distanceMeters / 1000).toFixed(1)}`,
    `  tss: ${Math.round(totals.tss)}`,
    `  elev_gain_m: ${Math.round(totals.elevationGainMeters)}`,
    "by_sport:",
    ...(sportLines.length > 0 ? sportLines : ["  {}"]),
    ...loadLines,
    ...intentLines,
    ...adherenceLines,
    `generated_at: ${ctx.generatedAt.toISOString()}`,
    "source: trainingpeaks",
    "---",
  ];
  return lines.join("\n");
}

function fmtYamlNumber(v: number | null): string {
  return v === null ? "null" : String(v);
}

function yamlKey(s: string): string {
  // quote if non-alpha
  return /^[A-Za-z][\w-]*$/.test(s) ? s : `"${s.replaceAll('"', '\\"')}"`;
}

interface Totals {
  workouts: number;
  durationSeconds: number;
  distanceMeters: number;
  tss: number;
  elevationGainMeters: number;
}

function emptyTotals(): Totals {
  return {
    workouts: 0,
    durationSeconds: 0,
    distanceMeters: 0,
    tss: 0,
    elevationGainMeters: 0,
  };
}

function computeTotals(workouts: Workout[]): Totals {
  const t = emptyTotals();
  for (const w of workouts) {
    t.workouts++;
    t.durationSeconds += w.actual.durationSeconds ?? w.planned.durationSeconds ?? 0;
    t.distanceMeters += w.actual.distanceMeters ?? 0;
    t.tss += w.actual.tss ?? w.planned.tss ?? 0;
    t.elevationGainMeters += w.actual.elevationGainMeters ?? 0;
  }
  return t;
}

function computeBySport(workouts: Workout[]): Map<string, Totals> {
  const map = new Map<string, Totals>();
  for (const w of workouts) {
    let t = map.get(w.sport);
    if (!t) {
      t = emptyTotals();
      map.set(w.sport, t);
    }
    t.workouts++;
    t.durationSeconds += w.actual.durationSeconds ?? w.planned.durationSeconds ?? 0;
    t.distanceMeters += w.actual.distanceMeters ?? 0;
    t.tss += w.actual.tss ?? w.planned.tss ?? 0;
    t.elevationGainMeters += w.actual.elevationGainMeters ?? 0;
  }
  return map;
}

function renderTotalsTable(totals: Totals, bySport: Map<string, Totals>): string {
  const rows: string[] = [];
  rows.push("| Sport | Sessions | Duration | Distance | TSS |");
  rows.push("|---|---:|---:|---:|---:|");
  for (const [sport, t] of bySport) {
    rows.push(
      `| ${tcell(sport)} | ${t.workouts} | ${fmtDuration(t.durationSeconds)} | ${fmtKm(t.distanceMeters)} | ${Math.round(t.tss)} |`,
    );
  }
  rows.push(
    `| **Total** | **${totals.workouts}** | **${fmtDuration(totals.durationSeconds)}** | **${fmtKm(totals.distanceMeters)}** | **${Math.round(totals.tss)}** |`,
  );
  return rows.join("\n");
}

function renderWorkout(w: Workout): string {
  const status = w.completed ? "completed" : "planned";
  const head = w.startTime
    ? `### ${w.startTime} · ${w.sport} · ${w.title} — *${status}*`
    : `### ${w.sport} · ${w.title} — *${status}*`;

  const parts: string[] = [head, ""];

  parts.push(renderStatsTable(w));
  parts.push("");

  if (w.description) {
    parts.push("**Description**");
    parts.push("");
    parts.push(blockquote(w.description));
    parts.push("");
  }

  if (w.coachInstruction) {
    parts.push("**Coach instruction**");
    parts.push("");
    parts.push(blockquote(w.coachInstruction));
    parts.push("");
  }

  if (w.structure && w.structure.length > 0) {
    const rendered = renderStructure(w.structure, 0);
    if (rendered.trim().length > 0) {
      parts.push("**Planned structure**");
      parts.push("");
      parts.push(rendered);
      parts.push("");
    }
  }

  if (w.laps.length > 0) {
    parts.push("**Laps**");
    parts.push("");
    parts.push(renderLaps(w.laps, w.sport));
    parts.push("");
  }

  if (w.discussion.length > 0) {
    parts.push("**Discussion**");
    parts.push("");
    for (const c of w.discussion) {
      parts.push(renderComment(c));
      parts.push("");
    }
  }

  const { intent, signals } = classifyIntent(w);
  const complianceParts: string[] = [];
  if (w.completed && w.planned.durationSeconds !== undefined && w.planned.durationSeconds > 0) {
    const r =
      Math.round(((w.actual.durationSeconds ?? 0) / w.planned.durationSeconds) * 100) / 100;
    complianceParts.push(`duration=${r}`);
  }
  if (w.completed && w.planned.tss !== undefined && w.planned.tss > 0) {
    const r = Math.round(((w.actual.tss ?? 0) / w.planned.tss) * 100) / 100;
    complianceParts.push(`tss=${r}`);
  }
  const complianceStr = complianceParts.length > 0 ? `, compliance: ${complianceParts.join(" ")}` : "";
  parts.push(
    `<!-- workout_id: ${w.id}, intent: ${intent} (${signals.join(",")})${complianceStr} -->`,
  );
  return parts.join("\n");
}

function renderStatsTable(w: Workout): string {
  const rows: string[] = [];
  rows.push("| Metric | Planned | Actual |");
  rows.push("|---|---:|---:|");
  rows.push(
    `| Duration | ${fmtDuration(w.planned.durationSeconds)} | ${fmtDuration(w.actual.durationSeconds)} |`,
  );
  rows.push(
    `| Distance | ${fmtKm(w.planned.distanceMeters)} | ${fmtKm(w.actual.distanceMeters)} |`,
  );
  rows.push(`| TSS | ${fmtInt(w.planned.tss)} | ${fmtInt(w.actual.tss)} |`);
  rows.push(
    `| IF | ${fmtFloat(w.planned.intensityFactor, 2)} | ${fmtFloat(w.actual.intensityFactor, 2)} |`,
  );
  if (w.actual.hrAvg !== undefined || w.actual.hrMax !== undefined) {
    rows.push(`| HR avg / max | — | ${fmtInt(w.actual.hrAvg)} / ${fmtInt(w.actual.hrMax)} bpm |`);
  }
  if (
    w.actual.powerAvg !== undefined ||
    w.actual.powerMax !== undefined ||
    w.actual.powerNormalized !== undefined
  ) {
    rows.push(
      `| Power avg / NP / max | — | ${fmtInt(w.actual.powerAvg)} / ${fmtInt(w.actual.powerNormalized)} / ${fmtInt(w.actual.powerMax)} W |`,
    );
  }
  if (w.actual.cadenceAvg !== undefined) {
    rows.push(`| Cadence avg | — | ${fmtInt(w.actual.cadenceAvg)} |`);
  }
  if (w.actual.speedAvgMps !== undefined && isRun(w.sport)) {
    rows.push(`| Pace avg | — | ${fmtPaceFromMps(w.actual.speedAvgMps)} |`);
  }
  if (w.actual.elevationGainMeters !== undefined) {
    rows.push(`| Elevation gain | — | ${fmtMeters(w.actual.elevationGainMeters)} |`);
  }
  if (w.actual.calories !== undefined) {
    rows.push(`| Calories | — | ${fmtInt(w.actual.calories)} kcal |`);
  }
  return rows.join("\n");
}

function isRun(sport: string): boolean {
  return /run|walk|hike/i.test(sport);
}

function renderStructure(steps: StructureStep[], depth: number): string {
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  for (const s of steps) {
    if (s.kind === "repeat") {
      const inner = renderStructure(s.steps, depth + 1);
      if (!inner) continue; // empty repeat — skip
      lines.push(`${pad}- ${s.reps}× repeat`);
      lines.push(inner);
    } else {
      const hasDuration = s.durationSeconds !== undefined;
      const hasIntensity = s.intensityMin !== undefined || s.intensityMax !== undefined;
      const hasName = Boolean(s.name?.trim());
      const hasCadence = s.cadenceMin !== undefined || s.cadenceMax !== undefined;
      const hasIntensityClass =
        Boolean(s.intensityClass) && s.intensityClass !== "active";
      // Skip totally uninformative steps (no name, no duration, no target, no useful class).
      if (!hasName && !hasDuration && !hasIntensity && !hasIntensityClass && !hasCadence)
        continue;
      const dur = hasDuration ? ` — ${fmtLapDuration(s.durationSeconds!)}` : "";
      const intensity = hasIntensity
        ? ` ${fmtIntensity(s.intensityMin, s.intensityMax, s.intensityUnit)}`
        : "";
      const name = s.name?.trim() || s.intensityClass || "Step";
      // Suppress cadence annotation when the step name already mentions it
      // ("Hoge cadans", "high cadence", "100rpm").
      const nameMentionsCadence = /cadans|cadence|rpm/i.test(name);
      const cadence =
        hasCadence && !nameMentionsCadence
          ? ` (cad ${fmtRange(s.cadenceMin, s.cadenceMax)} rpm)`
          : "";
      lines.push(`${pad}- ${name}${dur}${intensity}${cadence}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * Format a structured-workout intensity target. Examples:
 *   percentOfFtp 110-130        → "@ 110–130% FTP"
 *   percentOfFtp 85-85          → "@ 85% FTP"
 *   percentOfFtp 120-undef      → "@ ≥120% FTP"
 *   percentOfThresholdHr 80-88  → "@ 80–88% LTHR"
 *   rpe 7-8                     → "@ RPE 7–8"
 *   power 240-280               → "@ 240–280 W"
 *   heartRate 145-155           → "@ 145–155 bpm"
 *   pace 3.0-3.5 (m/s)          → "@ 4:46–5:33/km"  (run/swim only)
 *   undef unit, 110-130         → "@ 110–130"
 */
function fmtIntensity(
  min: number | undefined,
  max: number | undefined,
  unit: string | undefined,
): string {
  // Special case: RPE reads as "RPE 7–8", not "7–8 RPE".
  if (unit === "rpe") return `@ RPE ${fmtRange(min, max)}`;

  // Pace: TP delivers as meters-per-second; render as min:sec/km.
  if (unit === "pace" || unit === "meterPerSecond") {
    const lo = mpsToPace(min);
    const hi = mpsToPace(max);
    if (lo && hi && lo === hi) return `@ ${lo}/km`;
    if (lo && hi) {
      // Faster pace = lower seconds per km, but higher m/s. Range reads
      // faster→slower, i.e. fast(=max m/s) to slow(=min m/s).
      return `@ ${mpsToPace(max)}–${mpsToPace(min)}/km`;
    }
    if (lo) return `@ ≥${lo}/km`;
    if (hi) return `@ ≤${hi}/km`;
    return "";
  }

  const range = fmtRange(min, max);
  const suffix = unitSuffix(unit);
  // Suffix already starts with the right separator: "% FTP" attaches directly,
  // " W" / " bpm" need their leading space.
  return `@ ${range}${suffix}`;
}

/** Render a min/max numeric range, collapsing equal values and one-sided
 *  ranges to "≥X" / "≤Y". */
function fmtRange(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) {
    if (min === max) return `${min}`;
    return `${min}–${max}`;
  }
  if (min !== undefined) return `≥${min}`;
  if (max !== undefined) return `≤${max}`;
  return "";
}

/** Map a TP intensity-metric string to a human-readable suffix. */
function unitSuffix(u: string | undefined): string {
  if (!u) return "";
  switch (u) {
    case "percentOfFtp":
      return "% FTP";
    case "percentOfThresholdHr":
      return "% LTHR";
    case "percentOfMaxHr":
      return "% max HR";
    case "percentOfThresholdPace":
      return "% threshold pace";
    case "percentOfThresholdSwimPace":
      return "% CSS";
    case "heartRate":
      return " bpm";
    case "power":
      return " W";
    case "kilometerPerHour":
      return " km/h";
    case "milePerHour":
      return " mph";
    case "rpe":
      return ""; // handled specially above
    case "pace":
    case "meterPerSecond":
      return ""; // handled specially above
    case "roundOrStridePerMinute":
      return " rpm";
    default:
      return ` ${u}`;
  }
}

function mpsToPace(mps: number | undefined): string | undefined {
  if (mps === undefined || !Number.isFinite(mps) || mps <= 0) return undefined;
  const secPerKm = 1000 / mps;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderLaps(laps: Lap[], sport: string): string {
  const showPace = isRun(sport);
  const header = showPace
    ? "| # | Name | Duration | Distance | HR avg/max | Pace | Cadence |"
    : "| # | Name | Duration | Distance | HR avg/max | Power avg/max | Cadence |";
  const align = showPace
    ? "|---:|---|---:|---:|---:|---:|---:|"
    : "|---:|---|---:|---:|---:|---:|---:|";
  const rows = [header, align];

  // Collapse runs of near-identical consecutive laps into a single summary row.
  const groups = groupSimilarLaps(laps);
  for (const g of groups) {
    if (g.count === 1) {
      const l = g.laps[0];
      const hr = `${fmtInt(l.hrAvg)} / ${fmtInt(l.hrMax)}`;
      const cad = fmtInt(l.cadenceAvg);
      if (showPace) {
        rows.push(
          `| ${l.index} | ${tcell(l.name ?? "")} | ${fmtLapDuration(l.durationSeconds)} | ${fmtKm(l.distanceMeters)} | ${hr} | ${fmtPaceFromMps(l.speedAvgMps)} | ${cad} |`,
        );
      } else {
        const power = `${fmtInt(l.powerAvg)} / ${fmtInt(l.powerMax)}`;
        rows.push(
          `| ${l.index} | ${tcell(l.name ?? "")} | ${fmtLapDuration(l.durationSeconds)} | ${fmtKm(l.distanceMeters)} | ${hr} | ${power} | ${cad} |`,
        );
      }
    } else {
      // Summary row: "1–6" index range, "6× Lap N" name, averages.
      const idxRange = `${g.laps[0].index}–${g.laps[g.laps.length - 1].index}`;
      const name = `${g.count}× ${g.laps[0].name ?? "Lap"}`;
      const dur = fmtLapDuration(avg(g.laps.map((l) => l.durationSeconds)));
      const dist = fmtKm(avg(g.laps.map((l) => l.distanceMeters)));
      const hr = `${fmtInt(avg(g.laps.map((l) => l.hrAvg)))} / ${fmtInt(avg(g.laps.map((l) => l.hrMax)))}`;
      const cad = fmtInt(avg(g.laps.map((l) => l.cadenceAvg)));
      if (showPace) {
        rows.push(
          `| ${idxRange} | ${tcell(name)} | ${dur} avg | ${dist} avg | ${hr} | ${fmtPaceFromMps(avg(g.laps.map((l) => l.speedAvgMps)))} | ${cad} |`,
        );
      } else {
        const power = `${fmtInt(avg(g.laps.map((l) => l.powerAvg)))} / ${fmtInt(avg(g.laps.map((l) => l.powerMax)))}`;
        rows.push(
          `| ${idxRange} | ${tcell(name)} | ${dur} avg | ${dist} avg | ${hr} | ${power} | ${cad} |`,
        );
      }
    }
  }
  return rows.join("\n");
}

function avg(vals: Array<number | undefined>): number | undefined {
  const ok = vals.filter((v): v is number => typeof v === "number");
  if (ok.length === 0) return undefined;
  return ok.reduce((a, b) => a + b, 0) / ok.length;
}

interface LapGroup {
  laps: Lap[];
  count: number;
}

/**
 * Group consecutive laps that look like the same "role" (interval, rest).
 * Heuristic:
 *   - duration within 15% of the group's first lap
 *   - power (or pace) within 15% of the group's first lap
 *   - at least 3 consecutive laps to trigger a group
 */
function groupSimilarLaps(laps: Lap[]): LapGroup[] {
  const groups: LapGroup[] = [];
  let i = 0;
  while (i < laps.length) {
    let j = i + 1;
    while (j < laps.length && lapsSimilar(laps[i], laps[j])) j++;
    const runLen = j - i;
    if (runLen >= 3) {
      groups.push({ laps: laps.slice(i, j), count: runLen });
    } else {
      for (let k = i; k < j; k++) groups.push({ laps: [laps[k]], count: 1 });
    }
    i = j;
  }
  return groups;
}

function lapsSimilar(a: Lap, b: Lap): boolean {
  if (!within(a.durationSeconds, b.durationSeconds, 0.15)) return false;
  // Prefer power, fall back to speed.
  if (a.powerAvg !== undefined && b.powerAvg !== undefined) {
    return within(a.powerAvg, b.powerAvg, 0.15);
  }
  if (a.speedAvgMps !== undefined && b.speedAvgMps !== undefined) {
    return within(a.speedAvgMps, b.speedAvgMps, 0.15);
  }
  // If neither, fall back to HR.
  if (a.hrAvg !== undefined && b.hrAvg !== undefined) {
    return within(a.hrAvg, b.hrAvg, 0.1);
  }
  return false;
}

function within(a: number | undefined, b: number | undefined, tol: number): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 0 && b === 0) return true;
  const ref = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / ref <= tol;
}

function blockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

/**
 * Render one discussion-thread comment as a labelled blockquote.
 * Header line carries the role tag, author, and posted-at date so an LLM
 * (or human) can follow the conversation chronology.
 */
function renderComment(c: Comment): string {
  const tag = c.role === "coach" ? "[coach]" : "[athlete]";
  const date = c.postedAt ? c.postedAt.slice(0, 10) : "";
  const header = `**${tag} ${c.author}${date ? ` · ${date}` : ""}**`;
  return `${header}\n\n${blockquote(c.text)}`;
}

/**
 * Auto-generated week summary (past weeks). Bullets: adherence, TSS vs plan,
 * top session by TSS, biggest planned-vs-actual gap, load narrative.
 */
function renderWeekSummary(bucket: WeekBucket, ctx: RenderContext): string | null {
  if (ctx.phase !== "past") return null;
  if (bucket.workouts.length === 0) return null;

  const completed = bucket.workouts.filter((w) => w.completed);
  const planned = bucket.workouts.filter(
    (w) => w.planned.tss !== undefined || w.planned.durationSeconds !== undefined,
  );
  const plannedTss = bucket.workouts.reduce((a, w) => a + (w.planned.tss ?? 0), 0);
  const actualTss = bucket.workouts.reduce((a, w) => a + (w.actual.tss ?? 0), 0);

  // Top session by actual TSS.
  const ranked = [...completed].sort(
    (a, b) => (b.actual.tss ?? 0) - (a.actual.tss ?? 0),
  );
  const top = ranked[0];

  // Biggest planned-vs-actual gap (|actual - planned| tss).
  const gapped = bucket.workouts
    .filter((w) => w.planned.tss !== undefined)
    .map((w) => ({
      w,
      gap: (w.actual.tss ?? 0) - (w.planned.tss ?? 0),
    }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const biggestGap = gapped[0];

  const bullets: string[] = [];
  bullets.push(
    `- **Sessions**: ${completed.length}/${planned.length || bucket.workouts.length} completed`,
  );
  if (plannedTss > 0) {
    const pct = Math.round((actualTss / plannedTss) * 100);
    bullets.push(
      `- **TSS**: ${Math.round(actualTss)} actual vs ${Math.round(plannedTss)} planned (${pct}%)`,
    );
  } else {
    bullets.push(`- **TSS**: ${Math.round(actualTss)} actual`);
  }
  if (ctx.load?.ctl_end !== null && ctx.load?.ctl_end !== undefined) {
    const ramp =
      ctx.load.ramp_rate !== null && ctx.load.ramp_rate !== undefined
        ? ` (Δ${ctx.load.ramp_rate >= 0 ? "+" : ""}${ctx.load.ramp_rate}/wk)`
        : "";
    bullets.push(
      `- **Load**: CTL ${ctx.load.ctl_end}${ramp}, ATL ${ctx.load.atl_end}, TSB ${ctx.load.tsb_end}`,
    );
  }
  if (top && (top.actual.tss ?? 0) > 0) {
    bullets.push(
      `- **Top session**: ${top.sport} — ${top.title} (TSS ${Math.round(top.actual.tss ?? 0)})`,
    );
  }
  if (biggestGap && Math.abs(biggestGap.gap) >= 10) {
    const sign = biggestGap.gap > 0 ? "+" : "";
    bullets.push(
      `- **Biggest plan gap**: ${biggestGap.w.sport} — ${biggestGap.w.title} (${sign}${Math.round(biggestGap.gap)} TSS)`,
    );
  }

  return ["## Week summary", "", ...bullets].join("\n");
}

/**
 * Compact planned-ahead table (current week). Shows sessions not yet completed
 * with their intent tag so an LLM sees commitments before suggesting changes.
 */
function renderPlannedAhead(bucket: WeekBucket, ctx: RenderContext): string | null {
  if (ctx.phase !== "current" && ctx.phase !== "future") return null;
  const future = bucket.workouts.filter((w) => !w.completed);
  if (future.length === 0) return null;

  const rows: string[] = [];
  rows.push("## Planned ahead");
  rows.push("");
  rows.push("| Date | Sport | Title | Intent | Planned duration | Planned TSS |");
  rows.push("|---|---|---|---|---:|---:|");
  for (const w of future) {
    const { intent } = classifyIntent(w);
    rows.push(
      `| ${w.date}${w.startTime ? ` ${w.startTime}` : ""} | ${w.sport} | ${tcell(w.title)} | ${intent} | ${fmtDuration(w.planned.durationSeconds)} | ${fmtInt(w.planned.tss)} |`,
    );
  }
  return rows.join("\n");
}
