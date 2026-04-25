import path from "node:path";
import type { Workout, StructureStep, Lap } from "../transform/workout.js";
import { classifyIntent, type Intent } from "../transform/intent.js";
import { writeAtomic, ensureDir } from "../io/fs.js";
import { isoWeekOf } from "../util/isoWeek.js";

export interface JsonlContext {
  athleteId: number;
  timezone: string;
  generatedAt: Date;
  generatedDir: string; // absolute path to <workspace>/.tp
}

/**
 * Stable-key-order projection of a Workout to the JSONL schema.
 *
 * Philosophy:
 *   - every record has the same top-level shape, missing values are `null`
 *     (not omitted) so downstream consumers can trust the key set
 *   - laps and structure are referenced, not inlined, so lines stay compact
 *     and greppable
 *   - all units normalised: durations in seconds, distance in meters,
 *     speed implicit in the unit-suffixed keys
 */
export interface WorkoutRecord {
  workout_id: number;
  date: string;
  iso_year: number;
  iso_week: number;
  dow: number; // 1 = Monday .. 7 = Sunday
  start_time: string | null;
  sport: string;
  title: string;
  status: "completed" | "planned";
  intent: Intent;
  intent_signals: string[];
  planned: {
    duration_s: number | null;
    distance_m: number | null;
    tss: number | null;
    if: number | null;
  };
  actual: {
    duration_s: number | null;
    distance_m: number | null;
    tss: number | null;
    if: number | null;
    hr_avg: number | null;
    hr_max: number | null;
    power_avg: number | null;
    power_np: number | null;
    power_max: number | null;
    cadence_avg: number | null;
    speed_avg_mps: number | null;
    elev_gain_m: number | null;
    elev_loss_m: number | null;
    calories: number | null;
  };
  compliance: {
    duration: number | null;
    tss: number | null;
  };
  description: string | null;
  coach_instruction: string | null;
  discussion: Array<{
    author: string;
    role: "coach" | "athlete";
    posted_at: string;
    text: string;
  }>;
  structure_ref: string | null;
  laps_ref: string | null;
  last_modified: string | null;
  source: "trainingpeaks";
}

function nn(v: number | undefined): number | null {
  return v === undefined ? null : v;
}

function s(v: string | undefined): string | null {
  return v === undefined ? null : v;
}

function dowFromDate(yyyyMmDd: string): number {
  // Monday = 1 .. Sunday = 7
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  const js = d.getUTCDay(); // 0 = Sun .. 6 = Sat
  return js === 0 ? 7 : js;
}

export function workoutToRecord(w: Workout, timezone: string): WorkoutRecord {
  const iso = isoWeekOf(w.instant, timezone);
  const status: "completed" | "planned" = w.completed ? "completed" : "planned";
  const hasStructure = Boolean(w.structure && w.structure.length > 0);
  const hasLaps = w.laps.length > 0;
  const { intent, signals } = classifyIntent(w);

  const complianceDuration = ratio(w.actual.durationSeconds, w.planned.durationSeconds);
  const complianceTss = ratio(w.actual.tss, w.planned.tss);

  return {
    workout_id: w.id,
    date: w.date,
    iso_year: iso.isoYear,
    iso_week: iso.isoWeek,
    dow: dowFromDate(w.date),
    start_time: s(w.startTime),
    sport: w.sport,
    title: w.title,
    status,
    intent,
    intent_signals: signals,
    planned: {
      duration_s: nn(w.planned.durationSeconds),
      distance_m: nn(w.planned.distanceMeters),
      tss: nn(w.planned.tss),
      if: nn(w.planned.intensityFactor),
    },
    actual: {
      duration_s: nn(w.actual.durationSeconds),
      distance_m: nn(w.actual.distanceMeters),
      tss: nn(w.actual.tss),
      if: nn(w.actual.intensityFactor),
      hr_avg: nn(w.actual.hrAvg),
      hr_max: nn(w.actual.hrMax),
      power_avg: nn(w.actual.powerAvg),
      power_np: nn(w.actual.powerNormalized),
      power_max: nn(w.actual.powerMax),
      cadence_avg: nn(w.actual.cadenceAvg),
      speed_avg_mps: nn(w.actual.speedAvgMps),
      elev_gain_m: nn(w.actual.elevationGainMeters),
      elev_loss_m: nn(w.actual.elevationLossMeters),
      calories: nn(w.actual.calories),
    },
    compliance: {
      duration: complianceDuration,
      tss: complianceTss,
    },
    description: s(w.description),
    coach_instruction: s(w.coachInstruction),
    discussion: w.discussion.map((c) => ({
      author: c.author,
      role: c.role,
      posted_at: c.postedAt,
      text: c.text,
    })),
    structure_ref: hasStructure ? `structure/${w.id}.json` : null,
    laps_ref: hasLaps ? `laps/${w.id}.json` : null,
    last_modified: s(w.lastModified),
    source: "trainingpeaks",
  };
}

function ratio(
  actual: number | undefined,
  planned: number | undefined,
): number | null {
  if (planned === undefined || planned === 0) return null;
  if (actual === undefined) return 0;
  return Math.round((actual / planned) * 100) / 100;
}

/**
 * Emit workouts.jsonl + sidecar laps/structure files under <workspace>/.tp/.
 * Full rewrite of workouts.jsonl every run.
 */
export async function emitWorkoutsJsonl(
  workouts: Workout[],
  ctx: JsonlContext,
): Promise<{ workoutsFile: string; lapsWritten: number; structureWritten: number }> {
  await ensureDir(ctx.generatedDir);

  // Sort chronologically for stable, diff-friendly output.
  const sorted = [...workouts].sort(
    (a, b) => a.instant.getTime() - b.instant.getTime() || a.id - b.id,
  );

  const lines: string[] = [];
  for (const w of sorted) {
    lines.push(JSON.stringify(workoutToRecord(w, ctx.timezone)));
  }

  const workoutsFile = path.join(ctx.generatedDir, "workouts.jsonl");
  await writeAtomic(workoutsFile, lines.join("\n") + "\n");

  let lapsWritten = 0;
  let structureWritten = 0;
  for (const w of sorted) {
    if (w.laps.length > 0) {
      const p = path.join(ctx.generatedDir, "laps", `${w.id}.json`);
      await writeAtomic(p, JSON.stringify(w.laps, null, 2) + "\n");
      lapsWritten++;
    }
    if (w.structure && w.structure.length > 0) {
      const p = path.join(ctx.generatedDir, "structure", `${w.id}.json`);
      await writeAtomic(p, JSON.stringify(w.structure, null, 2) + "\n");
      structureWritten++;
    }
  }

  return { workoutsFile, lapsWritten, structureWritten };
}

/** Re-exported for typing consumers. */
export type { StructureStep, Lap };
