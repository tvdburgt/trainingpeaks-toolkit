import type {
  TPWorkoutListItem,
  TPLap,
  TPStructure,
  TPStructureStep,
  TPEvent,
} from "../api/types.js";
import { WORKOUT_TYPE_BY_ID } from "../api/types.js";

export interface Workout {
  id: number;
  /** instant (UTC) best-effort representing the workout's start moment */
  instant: Date;
  /** the wall-clock date string "YYYY-MM-DD" in the athlete's tz */
  date: string;
  /** "HH:mm" start time in the athlete's tz, or undefined if no explicit time */
  startTime: string | undefined;
  sport: string;
  title: string;
  completed: boolean;
  lastModified: string | undefined;

  planned: {
    durationSeconds: number | undefined;
    distanceMeters: number | undefined;
    tss: number | undefined;
    intensityFactor: number | undefined;
  };

  actual: {
    durationSeconds: number | undefined;
    distanceMeters: number | undefined;
    tss: number | undefined;
    intensityFactor: number | undefined;
    elevationGainMeters: number | undefined;
    elevationLossMeters: number | undefined;
    calories: number | undefined;
    hrAvg: number | undefined;
    hrMax: number | undefined;
    powerAvg: number | undefined;
    powerMax: number | undefined;
    powerNormalized: number | undefined;
    cadenceAvg: number | undefined;
    cadenceMax: number | undefined;
    speedAvgMps: number | undefined;
    speedMaxMps: number | undefined;
  };

  description: string | undefined;
  /**
   * Static instruction attached to the planned workout by the coach
   * (e.g. "Use HR strap and GPS watch"). Distinct from `discussion` below,
   * which is the conversational thread.
   */
  coachInstruction: string | undefined;
  /** Athlete ↔ coach discussion thread, oldest-first. */
  discussion: Comment[];

  structure: StructureStep[] | undefined;
  laps: Lap[];
}

/** A single comment in the workout's discussion thread. */
export interface Comment {
  /** Commenter display name, e.g. "Tijmen van der Burgt". */
  author: string;
  /** "coach" or "athlete" — derived from the API's `isCoach` flag. */
  role: "coach" | "athlete";
  /** ISO timestamp of when the comment was posted. */
  postedAt: string;
  /** Comment body, trimmed; may contain newlines. */
  text: string;
}

export interface Lap {
  index: number;
  name: string | undefined;
  durationSeconds: number | undefined;
  distanceMeters: number | undefined;
  hrAvg: number | undefined;
  hrMax: number | undefined;
  powerAvg: number | undefined;
  powerMax: number | undefined;
  cadenceAvg: number | undefined;
  speedAvgMps: number | undefined;
  tss: number | undefined;
}

export type StructureStep =
  | {
      kind: "step";
      name: string | undefined;
      durationSeconds: number | undefined;
      intensityClass: string | undefined;
      intensityMin: number | undefined;
      intensityMax: number | undefined;
      /**
       * Resolved unit for the primary intensity target. For TP plans this
       * usually inherits from the structure root's `primaryIntensityMetric`
       * (e.g. "percentOfFtp", "percentOfThresholdHr", "percentOfThresholdPace")
       * because per-step targets ship with `unit: undefined`. Absolute units
       * such as "power", "heartRate", "pace", "rpe" are also possible.
       */
      intensityUnit: string | undefined;
      /** Cadence target, when present as a secondary target. rpm. */
      cadenceMin: number | undefined;
      cadenceMax: number | undefined;
    }
  | {
      kind: "repeat";
      reps: number;
      steps: StructureStep[];
    };

export interface Event {
  id: number | undefined;
  date: string; // YYYY-MM-DD athlete tz
  instant: Date;
  title: string;
  description: string | undefined;
  priority: string | undefined;
  sport: string | undefined;
  ctlTarget: number | undefined;
}

export function sportName(workoutTypeId: number | undefined): string {
  if (!workoutTypeId) return "Workout";
  return WORKOUT_TYPE_BY_ID[workoutTypeId] ?? `Type ${workoutTypeId}`;
}

function parseInstant(s: string | null | undefined): Date | undefined {
  if (!s) return undefined;
  // TP returns strings like "2025-04-01T08:15:00" (no tz). Treat as UTC-naive;
  // caller will re-project to athlete tz. This is consistent with how TP stores them.
  const d = new Date(s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function n(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function transformWorkout(
  raw: TPWorkoutListItem,
  rawLaps: TPLap[] | undefined,
  timezone: string,
): Workout {
  const instant =
    parseInstant(raw.startTime) ??
    parseInstant(raw.startTimePlanned) ??
    parseInstant(raw.workoutDay) ??
    new Date(0);

  // Wall-clock date/time in athlete tz, done via Intl for correctness.
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const tf = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const date = dtf.format(instant); // YYYY-MM-DD
  const hasExplicitTime =
    Boolean(raw.startTime) || Boolean(raw.startTimePlanned);
  const startTime = hasExplicitTime ? tf.format(instant) : undefined;

  const typeId = raw.workoutTypeValueId ?? raw.workoutTypeId;
  const sport = sportName(typeId);
  const title = raw.title?.trim() || sport;

  return {
    id: raw.workoutId,
    instant,
    date,
    startTime,
    sport,
    title,
    completed: n(raw.totalTime) !== undefined && (n(raw.totalTime) ?? 0) > 0,
    lastModified: raw.lastModifiedDate,
    planned: {
      durationSeconds: n(raw.totalTimePlanned)
        ? Math.round(n(raw.totalTimePlanned)! * 3600)
        : undefined,
      distanceMeters: n(raw.distancePlanned) ?? undefined,
      tss: n(raw.tssPlanned),
      intensityFactor: n(raw.ifPlanned),
    },
    actual: {
      durationSeconds: n(raw.totalTime) ? Math.round(n(raw.totalTime)! * 3600) : undefined,
      distanceMeters: n(raw.distance) ?? undefined,
      tss: n(raw.tssActual),
      intensityFactor: n(raw.if),
      elevationGainMeters: n(raw.elevationGain),
      elevationLossMeters: n(raw.elevationLoss),
      calories: n(raw.calories) ?? n(raw.energy),
      hrAvg: n(raw.heartRateAverage),
      hrMax: n(raw.heartRateMaximum),
      powerAvg: n(raw.powerAverage),
      powerMax: n(raw.powerMaximum),
      powerNormalized: n(raw.normalizedPowerActual),
      cadenceAvg: n(raw.cadenceAverage),
      cadenceMax: n(raw.cadenceMaximum),
      speedAvgMps: n(raw.velocityAverage),
      speedMaxMps: n(raw.velocityMaximum),
    },
    description: raw.description?.trim() || undefined,
    coachInstruction: raw.coachComments?.trim() || undefined,
    discussion: transformDiscussion(raw.workoutComments),
    structure: transformStructure(raw.structure ?? undefined),
    laps: (rawLaps ?? []).map(transformLap),
  };
}

function transformDiscussion(raw: unknown): Comment[] {
  if (!Array.isArray(raw)) return [];
  const out: Comment[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    const text = typeof c.comment === "string" ? c.comment.trim() : "";
    if (!text) continue;
    const author =
      typeof c.commenterName === "string" && c.commenterName.trim()
        ? c.commenterName.trim()
        : [c.firstName, c.lastName]
            .filter((p): p is string => typeof p === "string" && p.length > 0)
            .join(" ")
            .trim() || "Unknown";
    out.push({
      author,
      role: c.isCoach === true ? "coach" : "athlete",
      postedAt:
        typeof c.dateCreated === "string" ? c.dateCreated : "",
      text,
    });
  }
  // Oldest-first chronological. TP returns them sorted but be defensive.
  return out.sort((a, b) => a.postedAt.localeCompare(b.postedAt));
}

function transformLap(raw: TPLap): Lap {
  return {
    index: raw.lapNumber,
    name: raw.name ?? undefined,
    durationSeconds: n(raw.elapsedSec),
    distanceMeters: n(raw.distanceMeters),
    hrAvg: n(raw.heartRateAverage),
    hrMax: n(raw.heartRateMaximum),
    powerAvg: n(raw.powerAverage),
    powerMax: n(raw.powerMaximum),
    cadenceAvg: n(raw.cadenceAverage),
    speedAvgMps: n(raw.speedAverage),
    tss: n(raw.tssActual),
  };
}

function transformStructure(s: TPStructure | undefined): StructureStep[] | undefined {
  if (!s?.structure || !Array.isArray(s.structure)) return undefined;
  const primary = s.primaryIntensityMetric; // e.g. "percentOfFtp"
  const steps = s.structure
    .map((step) => transformStep(step, primary))
    .filter(Boolean) as StructureStep[];
  return steps.length > 0 ? steps : undefined;
}

/**
 * Convert a TP API structure node into our normalised form.
 *
 * TrainingPeaks wraps every top-level entry in a node whose `length.unit` is
 * `"repetition"`:
 *   - `length.value === 1` → a single step (unwrap to the inner child)
 *   - `length.value > 1`   → a real repeat (preserve as `kind: "repeat"`)
 *
 * Per-step targets ship with `unit: undefined` for the primary metric; the
 * actual unit lives at the structure root as `primaryIntensityMetric`. We
 * thread that down here so each leaf step records a resolved unit.
 *
 * Cadence is encoded as a secondary target with `unit: "roundOrStridePerMinute"`.
 */
function transformStep(
  step: TPStructureStep,
  primaryMetric: string | undefined,
): StructureStep | undefined {
  const lenUnit = step.length?.unit;
  const lenVal = step.length?.value ?? 0;

  // Repetition wrapper. length.unit === "repetition" means this node groups
  // child steps; length.value is how many times the inner block repeats.
  if (lenUnit === "repetition" && Array.isArray(step.steps)) {
    const inner = step.steps
      .map((s) => transformStep(s, primaryMetric))
      .filter(Boolean) as StructureStep[];
    if (inner.length === 0) return undefined;
    if (lenVal <= 1) {
      // Length-1 wrapper around a single concrete step: unwrap.
      // (If the wrapper somehow holds multiple inner steps with reps=1, emit
      // them flat — uncommon but keeps shape sane.)
      return inner.length === 1 ? inner[0] : { kind: "repeat", reps: 1, steps: inner };
    }
    return { kind: "repeat", reps: lenVal, steps: inner };
  }

  // Leaf step. Pick out primary intensity (first target with no unit, or
  // matching the primary metric) and cadence (target with rpm unit).
  const targets = step.targets ?? [];
  const cadence = targets.find((t) => t.unit === "roundOrStridePerMinute");
  const intensity = targets.find(
    (t) => t.unit === undefined || t.unit === primaryMetric,
  );

  return {
    kind: "step",
    name: step.name ?? undefined,
    durationSeconds: lenUnit === "second" ? lenVal : undefined,
    intensityClass: step.intensityClass ?? undefined,
    intensityMin: intensity?.minValue,
    intensityMax: intensity?.maxValue,
    intensityUnit: intensity ? intensity.unit ?? primaryMetric : undefined,
    cadenceMin: cadence?.minValue,
    cadenceMax: cadence?.maxValue,
  };
}

export function transformEvent(raw: TPEvent, timezone: string): Event {
  const instant =
    parseInstant(raw.startDate ?? raw.eventDate ?? null) ?? new Date(0);
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return {
    id: raw.eventId ?? raw.id,
    date: dtf.format(instant),
    instant,
    title: raw.name ?? raw.title ?? "Event",
    description: raw.description?.trim() || undefined,
    priority: raw.priority,
    sport: raw.workoutTypeId ? sportName(raw.workoutTypeId) : undefined,
    ctlTarget: n(raw.ctlTarget ?? null),
  };
}
